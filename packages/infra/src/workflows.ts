/**
 * Checks a product's own GitHub workflows against the rules its `pebble-infra` steps depend on: the role, state and
 * environment each job uses, the secrets it reads, which jobs may clear a stack's lock, and that a deploy migrates
 * before `up`. Every product fact comes from the caller; the rules never ask for a job graph or a trigger.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';

import type { ConfigValues, EntriesModule } from './config.js';
import { parseEnv } from './names.js';
import { deployState, githubEnvironment, type DeployEnv, type StageKind } from './stage.js';

/** `stack`, `state`, `secrets`, `lock`, `concurrency` or `migrate`: the rule a violation breaks. */
export type WorkflowRule = 'stack' | 'state' | 'secrets' | 'lock' | 'concurrency' | 'migrate';

export interface WorkflowViolation {
  rule: WorkflowRule;
  /** `<workflow file>#<job>`, or `environment <name>` for a table secret no job reads. */
  job: string;
  message: string;
}

export interface WorkflowChecks {
  /** The product's workflow files. */
  workflows: readonly string[];
  /** Product id: the state path is `<product>/<env>`. */
  product: string;
  /** AWS region in the `s3://` backend and `awskms://` key URLs. */
  region: string;
  /** The product's entries module: the values each `configure`, `up` and `preview` needs. */
  entries: EntriesModule;
  /** Every secret set in each GitHub environment, by environment name (`preview`, `staging`, `production`). */
  secrets: Readonly<Record<string, readonly string[]>>;
  /**
   * The stacks whose program owns a database, and the step output (snake case, as `pebble-infra` writes it) holding
   * its URL; `false` for a product with no database.
   */
  database: false | { output: string; stacks: readonly StageKind[] };
  /**
   * The stacks a job touches when a `pebble-infra` step names its stack by an expression the helper cannot read,
   * by `<workflow file>#<job>`: `{ 'release.yml#deploy': ['prod'] }`. A matrix list and a `choice` input are read.
   */
  stacks?: Readonly<Record<string, readonly string[]>>;
}

export interface Concurrency {
  group: string;
  'cancel-in-progress'?: unknown;
  queue?: unknown;
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env: Record<string, string>;
  with: Record<string, string>;
}

export interface WorkflowJob {
  environment?: string;
  needs: string[];
  if?: string;
  concurrency?: Concurrency;
  env: Record<string, string>;
  outputs: Record<string, string>;
  strategy?: { matrix?: unknown };
  steps: WorkflowStep[];
}

export interface Workflow {
  /** The file name without its directory, as violations name it. */
  file: string;
  on: Record<string, any>;
  concurrency?: Concurrency;
  env: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
const strings = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).map(([k, v]) => [k, text(v)]));

function concurrency(value: unknown): Concurrency | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return { group: text(value) };
  const { group, ...rest } = value as Record<string, unknown>;
  return { group: group === undefined ? '' : text(group), ...rest };
}

function normalize(file: string, raw: Record<string, any>): Workflow {
  const jobs: Record<string, WorkflowJob> = {};
  for (const [key, job] of Object.entries((raw.jobs ?? {}) as Record<string, any>)) {
    const environment = typeof job.environment === 'object' ? job.environment?.name : job.environment;
    jobs[key] = {
      ...(environment === undefined ? {} : { environment: text(environment) }),
      needs: job.needs === undefined ? [] : [job.needs].flat().map(text),
      ...(job.if === undefined ? {} : { if: text(job.if) }),
      ...(job.concurrency === undefined ? {} : { concurrency: concurrency(job.concurrency) }),
      env: strings(job.env),
      outputs: strings(job.outputs),
      ...(job.strategy === undefined ? {} : { strategy: job.strategy }),
      steps: ((job.steps ?? []) as Record<string, any>[]).map((step) => ({
        ...(step.id === undefined ? {} : { id: text(step.id) }),
        ...(step.name === undefined ? {} : { name: text(step.name) }),
        ...(step.if === undefined ? {} : { if: text(step.if) }),
        ...(step.uses === undefined ? {} : { uses: text(step.uses) }),
        ...(step.run === undefined ? {} : { run: text(step.run) }),
        env: strings(step.env),
        with: strings(step.with),
      })),
    };
  }
  // YAML 1.2 keeps `on` a string key; a workflow written `on: push` is one trigger with no settings.
  const on =
    typeof raw.on === 'string'
      ? { [raw.on]: null }
      : Array.isArray(raw.on)
        ? Object.fromEntries(raw.on.map((t: string) => [t, null]))
        : (raw.on ?? {});
  return {
    file,
    on,
    ...(raw.concurrency === undefined ? {} : { concurrency: concurrency(raw.concurrency) }),
    env: strings(raw.env),
    jobs,
  };
}

/** Reads and parses one workflow file, with each job's steps, env and concurrency in one shape. */
export function loadWorkflow(path: string): Workflow {
  return normalize(basename(path), parse(readFileSync(path, 'utf8')) as Record<string, any>);
}

// One run of a job with its matrix values and `choice` inputs written in: what GitHub would run.
interface Variant {
  id: string;
  label: string;
  workflow: Workflow;
  key: string;
  job: WorkflowJob;
}

const EXPRESSION = /\$\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

function substitute<T>(value: T, binding: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(EXPRESSION, (whole, path: string) => binding[path] ?? whole) as T;
  if (Array.isArray(value)) return value.map((item) => substitute(item, binding)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, binding)])) as T;
  return value;
}

/** The legs of a literal matrix: list keys crossed, then `include` and `exclude`. A matrix expression gives none. */
function matrixLegs(matrix: unknown): Record<string, string>[] {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return [{}];
  const { include, exclude, ...keys } = matrix as Record<string, unknown>;
  let legs: Record<string, string>[] = Object.keys(keys).length > 0 ? [{}] : [];
  for (const [key, values] of Object.entries(keys)) {
    if (!Array.isArray(values)) return [{}];
    legs = legs.flatMap((leg) => values.map((value) => ({ ...leg, [`matrix.${key}`]: text(value) })));
  }
  const prefixed = (entry: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(entry).map(([k, v]) => [`matrix.${k}`, text(v)]));
  const matches = (leg: Record<string, string>, entry: Record<string, string>) =>
    Object.entries(entry).every(([k, v]) => !(k in leg) || leg[k] === v);
  for (const entry of Array.isArray(exclude) ? exclude : []) {
    const wanted = prefixed(entry);
    legs = legs.filter((leg) => !Object.entries(wanted).every(([k, v]) => leg[k] === v));
  }
  const original = Object.keys(keys).map((k) => `matrix.${k}`);
  for (const entry of Array.isArray(include) ? include : []) {
    const extra = prefixed(entry);
    const onOriginal = Object.fromEntries(Object.entries(extra).filter(([k]) => original.includes(k)));
    const hit = Object.keys(keys).length > 0 ? legs.filter((leg) => matches(leg, onOriginal)) : [];
    if (hit.length > 0) for (const leg of hit) Object.assign(leg, extra);
    else legs.push(extra);
  }
  return legs.length > 0 ? legs : [{}];
}

/** Each `workflow_dispatch` input of type `choice`, by name, with its options. */
function choiceInputs(workflow: Workflow): Record<string, string[]> {
  const inputs = (workflow.on.workflow_dispatch?.inputs ?? {}) as Record<string, { type?: string; options?: unknown }>;
  const choices: Record<string, string[]> = {};
  for (const [name, input] of Object.entries(inputs)) {
    if (input?.type === 'choice' && Array.isArray(input.options)) choices[name] = input.options.map(text);
  }
  return choices;
}

function variants(workflow: Workflow): Variant[] {
  const choices = choiceInputs(workflow);
  return Object.entries(workflow.jobs).flatMap(([key, job]) => {
    const seen = JSON.stringify([job, workflow.env, workflow.concurrency]);
    let bindings = matrixLegs(job.strategy?.matrix);
    for (const [name, options] of Object.entries(choices)) {
      if (!new RegExp(`\\binputs\\.${name}\\b`).test(seen)) continue;
      const bind = (option: string) => ({ [`inputs.${name}`]: option, [`github.event.inputs.${name}`]: option });
      bindings = bindings.flatMap((binding) => options.map((option) => ({ ...binding, ...bind(option) })));
    }
    return bindings.map((binding) => {
      const shown = Object.entries(binding)
        .filter(([k]) => !k.startsWith('github.event.'))
        .map(([k, v]) => `${k}=${v}`);
      return {
        id: `${workflow.file}#${key}`,
        label: `${workflow.file}#${key}${shown.length > 0 ? ` (${shown.join(', ')})` : ''}`,
        workflow: {
          ...workflow,
          env: substitute(workflow.env, binding),
          ...(workflow.concurrency ? { concurrency: substitute(workflow.concurrency, binding) } : {}),
        },
        key,
        job: substitute(job, binding),
      };
    });
  });
}

// `pebble-infra <verb> <stack> [flags]` as a workflow step runs it.
interface Command {
  verb: string;
  stackArg?: string;
  flags: Set<string>;
  options: Record<string, string>;
  text: string;
}

const VALUE_FLAGS = new Set(['--entries', '--outputs', '--product', '--owner']);

function words(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g))
    found.push(match[1] ?? match[2] ?? match[3]!);
  return found;
}

function commands(run: string): Command[] {
  const lines = run.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const found: Command[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/(?:^|[\s;&|(])pebble-infra\s+([^;&|#\n]*)/g)) {
      const [verb = '', ...rest] = words(match[1]!.trim());
      const flags = new Set<string>();
      const options: Record<string, string> = {};
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i]!;
        const [flag, inline] = word.split(/=(.*)/s);
        if (!word.startsWith('--')) positionals.push(word);
        else if (VALUE_FLAGS.has(flag!)) options[flag!] = inline ?? rest[++i] ?? '';
        else flags.add(word);
      }
      found.push({
        verb,
        ...(verb === 'pg-database' ? {} : { stackArg: positionals[0] }),
        flags,
        options,
        text: `pebble-infra ${match[1]!.trim()}`,
      });
    }
  }
  return found;
}

/** `pulumi <command>` run directly, other than logging in or reading the CLI's own state. */
function rawPulumi(run: string): string[] {
  const allowed = new Set(['login', 'logout', 'version', 'whoami', 'about', 'plugin']);
  return [...run.matchAll(/(?:^|[\s;&|(])pulumi\s+([a-z][\w-]*)/g)]
    .map((m) => m[1]!)
    .filter((command) => !allowed.has(command));
}

const stepEnv = (variant: Variant, step: WorkflowStep) => ({
  ...variant.workflow.env,
  ...variant.job.env,
  ...step.env,
});

/** `$VAR` and `${VAR}` written in from the step's env; GitHub expressions stay as written. */
function expand(arg: string, env: Record<string, string>): string {
  return arg.replace(
    /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (whole, a?: string, b?: string) => env[(a ?? b)!] ?? whole
  );
}

const LONG_LIVED = new Set(['shared', 'staging', 'prod']);
const PREVIEW_STACK = /^pr-(?:[1-9][0-9]*|\$\{\{[^}]*\}\})$/;

/** The stack kind of a stack name the helper can read, or undefined. */
function kindOf(stack: string): StageKind | undefined {
  if (LONG_LIVED.has(stack)) return parseEnv(stack).kind;
  return PREVIEW_STACK.test(stack) ? 'preview' : undefined;
}

// One `pebble-infra` command on one stack, in one job variant.
interface Touch {
  variant: Variant;
  index: number;
  step: WorkflowStep;
  command: Command;
  stack: string;
  kind: StageKind;
}

const stepName = (step: WorkflowStep, index: number) => (step.name ? `"${step.name}"` : `#${index + 1}`);
const deployEnvOf = (kind: StageKind): DeployEnv => (kind === 'shared' ? 'staging' : kind);

interface Context {
  options: WorkflowChecks;
  variants: Variant[];
  touches: Touch[];
  add: (rule: WorkflowRule, job: string, message: string) => void;
}

function collectTouches(context: Context): void {
  const { options, add } = context;
  for (const variant of context.variants) {
    variant.job.steps.forEach((step, index) => {
      if (!step.run) return;
      for (const command of rawPulumi(step.run)) {
        add(
          'stack',
          variant.id,
          `${variant.label} step ${stepName(step, index)} runs \`pulumi ${command}\` directly; run it through pebble-infra, whose stack and lock the checks read`
        );
      }
      for (const command of commands(step.run)) {
        if (command.stackArg === undefined) continue;
        const stack = expand(command.stackArg, stepEnv(variant, step));
        const declared = options.stacks?.[variant.id];
        const stacks = kindOf(stack) ? [stack] : (declared ?? []);
        if (stacks.length === 0) {
          add(
            'stack',
            variant.id,
            `${variant.label} step ${stepName(step, index)} runs \`${command.text}\` and the stack it names (${stack}) cannot be read; name it, take it from a matrix list or a choice input, or declare it in the \`stacks\` option under "${variant.id}"`
          );
        }
        for (const name of stacks) {
          const kind = kindOf(name);
          if (!kind) {
            add(
              'stack',
              variant.id,
              `${variant.id} is declared to touch "${name}", which is not shared, staging, prod or pr-<n>`
            );
            continue;
          }
          context.touches.push({ variant, index, step, command, stack: name, kind });
        }
      }
    });
  }
}

const isCredentials = (step: WorkflowStep) => step.uses?.startsWith('aws-actions/configure-aws-credentials@') ?? false;
const SECRET_REF = /^\$\{\{\s*secrets\.[A-Za-z_]\w*\s*\}\}$/;

/** Each job on a stack runs in the GitHub environment its deploy role trusts, assumes it, and logs in to its state. */
function stateRule({ options, touches, add }: Context): void {
  for (const touch of touches) {
    const { variant, step, index, stack, kind } = touch;
    const env = deployEnvOf(kind);
    const environment = githubEnvironment(env);
    if (variant.job.environment !== environment) {
      add(
        'state',
        variant.id,
        `${variant.label} touches ${stack} in environment ${variant.job.environment ?? '(none)'}; the ${env} deploy role trusts only ${environment}`
      );
    }
    const credentials = variant.job.steps.findIndex(isCredentials);
    if (credentials < 0 || credentials > index) {
      add(
        'state',
        variant.id,
        `${variant.label} touches ${stack} before any aws-actions/configure-aws-credentials step`
      );
    } else if (!SECRET_REF.test(variant.job.steps[credentials]!.with['role-to-assume'] ?? '')) {
      add(
        'state',
        variant.id,
        `${variant.label} assumes a role that is not \`\${{ secrets.<NAME> }}\` of its environment`
      );
    }
    const state = deployState(options.product, env);
    const path = `${options.product}/${kind === 'preview' ? 'preview' : stack}`;
    const expected = {
      PULUMI_BACKEND_URL: `s3://${state.bucket}/${path}?region=${options.region}`,
      PULUMI_SECRETS_PROVIDER: `awskms://${state.kmsAlias}?region=${options.region}`,
    };
    const scope = stepEnv(variant, step);
    for (const [name, value] of Object.entries(expected)) {
      if (scope[name] !== value) {
        add(
          'state',
          variant.id,
          `${variant.label} step ${stepName(step, index)} runs \`${touch.command.text}\` with ${name}=${scope[name] ?? '(unset)'}; ${stack} is ${value}`
        );
      }
    }
  }
}

const VALUES = /^\$\{\{\s*toJSON\(\s*secrets\s*\)\s*\}\}$/;
// What `derive` is called with for each available variable: shaped like a connection URL, the one value derive
// functions parse.
const PLACEHOLDER = 'postgresql://placeholder.placeholder:placeholder@placeholder.invalid:5432/placeholder';
const ALWAYS_SET = new Set(['GITHUB_TOKEN']);

function secretReads(value: unknown): string[] {
  const all = JSON.stringify(value);
  return [...all.matchAll(/secrets\.([A-Za-z_]\w*)|secrets\[\s*\\?['"]([^'"\\]+)\\?['"]\s*\]/g)]
    .map((m) => (m[1] ?? m[2])!)
    .filter((name) => !ALWAYS_SET.has(name));
}

/** The variables a `pebble-infra` command reads from its values: entries for configure, up and preview, and the admin URL of a preview database. */
function valuesNeeded(
  module: EntriesModule,
  command: Command,
  kind: StageKind
): { required: string[]; read: string[] } {
  const writes = ['configure', 'up', 'preview'].includes(command.verb);
  const entries = writes ? module.entries.filter((entry) => entry.stacks.includes(kind)) : [];
  const admin =
    module.previewDatabase === true &&
    kind === 'preview' &&
    (command.verb === 'up' ||
      command.verb === 'remove' ||
      (command.verb === 'prepare' && !command.flags.has('--preview-only')));
  const extra = admin ? ['PG_ADMIN_URL'] : [];
  return {
    required: [...entries.filter((entry) => entry.required).map((entry) => entry.env), ...extra],
    read: [...entries.map((entry) => entry.env), ...extra],
  };
}

/** Every secret a job reads is set in its environment, and every secret set there is read by some job. */
function secretsRule({ options, variants, touches, add }: Context): void {
  const read: Record<string, Set<string>> = {};
  for (const variant of variants) {
    const environment = variant.job.environment;
    const explicit = secretReads({ job: variant.job, env: variant.workflow.env });
    const usesValues = variant.job.steps.some((step) => VALUES.test(stepEnv(variant, step).PEBBLE_INFRA_VALUES ?? ''));
    if (explicit.length === 0 && !usesValues) continue;
    if (environment === undefined) continue;
    const table = options.secrets[environment];
    if (!table) {
      add(
        'secrets',
        variant.id,
        `${variant.label} reads secrets in environment ${environment}, which has no secrets table`
      );
      continue;
    }
    const seen = (read[environment] ??= new Set());
    for (const name of explicit) {
      seen.add(name);
      if (!table.includes(name))
        add(
          'secrets',
          variant.id,
          `${variant.label} reads secrets.${name}, which environment ${environment} does not set`
        );
    }
    for (const step of variant.job.steps) {
      // toJSON(secrets) on a step that runs no pebble-infra command hands it every secret.
      const onStep = touches.filter((t) => t.variant === variant && t.step === step);
      if (VALUES.test(stepEnv(variant, step).PEBBLE_INFRA_VALUES ?? '') && onStep.length === 0)
        for (const name of table) seen.add(name);
    }
  }

  for (const touch of touches) {
    const { variant, step, index, command, stack, kind } = touch;
    const environment = variant.job.environment;
    const table = environment === undefined ? undefined : options.secrets[environment];
    const scope = stepEnv(variant, step);
    const viaValues = VALUES.test(scope.PEBBLE_INFRA_VALUES ?? '');
    const { required, read: wanted } = valuesNeeded(options.entries, command, kind);
    if (required.length === 0 && wanted.length === 0) continue;
    const credentials = variant.job.steps.findIndex(isCredentials);
    const given = new Set([
      ...Object.entries(scope)
        .filter(([name, value]) => name !== 'PEBBLE_INFRA_VALUES' && value !== '')
        .map(([name]) => name),
      ...(viaValues && table ? table : []),
      ...(credentials >= 0 && credentials < index && variant.job.steps[credentials]!.with['aws-region']
        ? ['AWS_REGION', 'AWS_DEFAULT_REGION']
        : []),
    ]);
    // derive reads variables of its own (a URL it parses); record which, so they count as read.
    const derivedFrom = new Set<string>();
    let derived: ConfigValues = {};
    let deriveError = '';
    if (options.entries.derive && ['configure', 'up', 'preview'].includes(command.verb)) {
      const values = Object.fromEntries([...given].map((name) => [name, PLACEHOLDER]));
      const recorded = new Proxy(values, {
        get: (target, name) => {
          if (typeof name === 'string') derivedFrom.add(name);
          return target[name as string];
        },
      });
      try {
        derived = options.entries.derive(recorded, stack);
      } catch (error) {
        deriveError = ` (derive threw on placeholder values: ${(error as Error).message})`;
      }
    }
    if (viaValues && table && environment) {
      const seen = (read[environment] ??= new Set());
      for (const name of [...wanted, ...derivedFrom]) if (table.includes(name)) seen.add(name);
    }
    const missing = required.filter((name) => !given.has(name) && !derived[name]);
    if (missing.length > 0) {
      add(
        'secrets',
        variant.id,
        `${variant.label} step ${stepName(step, index)} runs \`${command.text}\`, which needs ${missing.join(', ')}; ${viaValues ? `environment ${environment ?? '(none)'} does not set ${missing.length === 1 ? 'it' : 'them'} and the step's env does not either` : "the step's env does not set them and it has no PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}"}${deriveError}`
      );
    }
  }

  for (const [environment, table] of Object.entries(options.secrets)) {
    for (const name of table) {
      if (!read[environment]?.has(name))
        add('secrets', `environment ${environment}`, `environment ${environment} sets ${name}, which no job reads`);
    }
  }
}

const groupOf = (variant: Variant) => variant.job.concurrency ?? variant.workflow.concurrency;
const cancels = (value: Concurrency | undefined) =>
  value !== undefined && value['cancel-in-progress'] !== undefined && value['cancel-in-progress'] !== false;

/** Whether one job needs the other, directly or through other jobs. */
function ordered(workflow: Workflow, a: string, b: string): boolean {
  const upstream = (from: string): Set<string> => {
    const found = new Set<string>();
    const queue = [...(workflow.jobs[from]?.needs ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (found.has(next)) continue;
      found.add(next);
      queue.push(...(workflow.jobs[next]?.needs ?? []));
    }
    return found;
  };
  return upstream(a).has(b) || upstream(b).has(a);
}

const isPreview = (command: Command) => command.verb === 'preview' || command.flags.has('--preview-only');
const clears = (touch: Touch) => touch.command.flags.has('--clear-lock') && !isPreview(touch.command);
const unique = (touches: Touch[]) => [...new Map(touches.map((t) => [t.variant.label, t.variant])).values()];

/** The group most of these jobs hold; ties go to the first job. */
function reference(variants: Variant[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of variants) {
    const group = groupOf(v)?.group;
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [group, count] of counts) if (best === undefined || count > counts.get(best)!) best = group;
  return best;
}

/**
 * Which jobs may clear a lock. On a long-lived stack, once any job passes `--clear-lock`, every job on that stack
 * shares one group that never cancels in progress. On `pr-<n>` stacks every job shares one group, which may cancel.
 * `preview` and `prepare --preview-only` never clear a lock.
 */
function lockRule({ touches, add }: Context): void {
  for (const { variant, command, stack } of touches) {
    if (isPreview(command) && command.flags.has('--clear-lock')) {
      add('lock', variant.id, `${variant.label} runs \`${command.text}\`: a preview never clears a lock (${stack})`);
    }
  }
  const byStack = new Map<string, Touch[]>();
  for (const touch of touches) {
    const key = touch.kind === 'preview' ? 'pr-<n>' : touch.stack;
    byStack.set(key, [...(byStack.get(key) ?? []), touch]);
  }
  for (const [stack, onStack] of byStack) {
    const jobs = unique(onStack);
    if (stack === 'pr-<n>') {
      const group = reference(jobs);
      for (const variant of jobs) {
        const own = groupOf(variant)?.group;
        if (!own || own !== group) {
          add(
            'lock',
            variant.id,
            `${variant.label} runs on pr-<n> in group ${own || '(none)'}, not ${group ?? '(none)'}: every job on a pr-<n> stack, remove included, shares the pull request's one concurrency group`
          );
        }
      }
    } else {
      const clearers = unique(onStack.filter(clears));
      for (const clearer of clearers) {
        const own = groupOf(clearer);
        const why = `every job passing --clear-lock on ${stack} shares one never-cancelled group with every other job on ${stack}`;
        if (!own?.group) {
          add(
            'lock',
            clearer.id,
            `${clearer.label} passes --clear-lock on ${stack} in no concurrency group, so two of its runs can clear each other's lock: ${why}`
          );
        }
        if ([clearer.job.concurrency, clearer.workflow.concurrency].some(cancels)) {
          add(
            'lock',
            clearer.id,
            `${clearer.label} passes --clear-lock on ${stack} in a group that may cancel it in progress: ${why}`
          );
        }
        const outside = own?.group
          ? jobs.filter((other) => other !== clearer && groupOf(other)?.group !== own.group)
          : [];
        if (outside.length > 0) {
          add(
            'lock',
            clearer.id,
            `${clearer.label} passes --clear-lock on ${stack} in group ${own?.group || '(none)'}, which ${outside.map((o) => `${o.label} (${groupOf(o)?.group || 'no group'})`).join(', ')} does not hold: ${why}`
          );
        }
      }
      if (clearers.length === 0) continue;
    }
    // Two jobs of one run that share only the workflow's group run side by side unless one needs the other.
    for (const [i, a] of jobs.entries()) {
      for (const b of jobs.slice(i + 1)) {
        if (a.workflow.file !== b.workflow.file || a.key === b.key) continue;
        if (a.job.concurrency || b.job.concurrency || ordered(a.workflow, a.key, b.key)) continue;
        add(
          'lock',
          b.id,
          `${b.label} and ${a.label} run on ${stack} in one workflow run with only the workflow's group between them; give each a job-level group or order them with needs`
        );
      }
    }
  }
}

/**
 * A never-cancelled group that holds more than one job on a stack queues every pending run (`queue: max`): by default a
 * group keeps one pending run, and a newer run of one job would drop the other's.
 */
function concurrencyRule({ touches, add }: Context): void {
  const stacks = new Set(touches.filter((t) => t.kind !== 'preview').map((t) => t.stack));
  for (const stack of stacks) {
    const onStack = touches.filter((t) => t.stack === stack);
    if (!onStack.some(clears)) continue;
    const jobs = [...new Map(onStack.map((t) => [t.variant.id, t.variant])).values()];
    if (jobs.length < 2) continue;
    for (const variant of jobs) {
      if (groupOf(variant)?.queue !== 'max') {
        add(
          'concurrency',
          variant.id,
          `${variant.label} shares ${stack} with ${jobs
            .filter((v) => v.id !== variant.id)
            .map((v) => v.id)
            .join(
              ', '
            )}, and its group ${groupOf(variant)?.group ?? '(none)'} does not set queue: max, so a newer run can drop a pending one`
        );
      }
    }
  }
}

const references = (step: WorkflowStep, expression: string) =>
  JSON.stringify({ run: step.run, env: step.env, with: step.with }).includes(expression);

/**
 * In each deploying job, a step before `up` reads the stack's database URL (from `outputs --if-exists`, or a job output
 * that carries it) and migrates; that step is guarded on the URL, and a step after `up`, guarded on it being empty,
 * migrates the first deploy from `up`'s own output.
 */
function migrateRule({ options, touches, add }: Context): void {
  if (!options.database) return;
  const { output, stacks } = options.database;
  const isRead = (t: Touch | undefined, stack: string) =>
    t !== undefined &&
    t.command.verb === 'outputs' &&
    t.stack === stack &&
    t.command.flags.has('--if-exists') &&
    t.command.flags.has('--github-output');
  for (const up of touches.filter((t) => t.command.verb === 'up' && stacks.includes(t.kind))) {
    const { variant, stack, index } = up;
    const reads: { expression: string; from: number }[] = [];
    variant.job.steps.forEach((step, i) => {
      if (i < index && step.id && touches.some((t) => t.variant === variant && t.step === step && isRead(t, stack)))
        reads.push({ expression: `steps.${step.id}.outputs.${output}`, from: i + 1 });
    });
    for (const need of variant.job.needs) {
      const prior = touches.filter(
        (t) => t.variant.workflow.file === variant.workflow.file && t.variant.key === need && isRead(t, stack)
      );
      for (const [name, value] of Object.entries(variant.workflow.jobs[need]?.outputs ?? {})) {
        if (prior.some((t) => t.step.id && value.includes(`steps.${t.step.id}.outputs.${output}`)))
          reads.push({ expression: `needs.${need}.outputs.${name}`, from: 0 });
      }
    }
    const steps = variant.job.steps;
    const migrate = reads.flatMap(({ expression, from }) =>
      steps
        .slice(from, index)
        .filter((step) => references(step, expression))
        .map((step) => ({ step, expression }))
    );
    if (migrate.length === 0) {
      add(
        'migrate',
        variant.id,
        `${variant.label} runs \`${up.command.text}\` (step ${stepName(up.step, index)}) before any step reads ${stack}'s ${output}: read it first with \`pebble-infra outputs ${stack} --github-output --if-exists\` and migrate before up`
      );
      continue;
    }
    if (!migrate.some(({ step, expression }) => step.if?.includes(expression))) {
      add(
        'migrate',
        variant.id,
        `${variant.label} migrates ${stack} before up with no guard on ${migrate[0]!.expression}: on a first deploy there is no stack yet and the URL is empty, so guard the step with \`if: ${migrate[0]!.expression} != ''\``
      );
    }
    const first = up.step.id
      ? steps
          .slice(index + 1)
          .some(
            (step) =>
              references(step, `steps.${up.step.id}.outputs.${output}`) &&
              migrate.some(({ expression }) => step.if?.includes(expression))
          )
      : false;
    if (!first) {
      add(
        'migrate',
        variant.id,
        `${variant.label} never migrates ${stack}'s first deploy: after up (which needs an id), add a step guarded \`if: ${migrate[0]!.expression} == ''\` that reads steps.${up.step.id ?? '<up id>'}.outputs.${output}`
      );
    }
  }
}

const RULES = [stateRule, secretsRule, lockRule, concurrencyRule, migrateRule];

/**
 * Checks the product's workflows; returns every violation, each naming its job and rule, or `[]`. A product's test
 * asserts `expect(checkWorkflows({...})).toEqual([])`.
 */
export function checkWorkflows(options: WorkflowChecks): WorkflowViolation[] {
  const violations: WorkflowViolation[] = [];
  const add = (rule: WorkflowRule, job: string, message: string) => {
    if (!violations.some((v) => v.rule === rule && v.job === job && v.message === message))
      violations.push({ rule, job, message });
  };
  const context: Context = {
    options,
    variants: options.workflows.map(loadWorkflow).flatMap(variants),
    touches: [],
    add,
  };
  collectTouches(context);
  for (const rule of RULES) rule(context);
  return violations;
}
