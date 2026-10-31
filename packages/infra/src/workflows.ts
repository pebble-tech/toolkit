/**
 * Checks a product's own GitHub workflows against the rules its `pebble-infra` steps depend on: the role, state and
 * environment each job uses, the secrets it reads, which jobs may clear a stack's lock, and that a deploy migrates
 * before `up`. Every product fact comes from the caller; the rules never ask for a job graph or a trigger. The helper
 * reads a narrow, documented subset of workflow text and fails, naming the rule and job, on anything outside it.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';

import type { EntriesModule } from './config.js';
import { deployState, githubEnvironment, type DeployEnv, type StageKind } from './stage.js';

/** `stack`, `state`, `secrets`, `lock`, `concurrency` or `migrate`: the rule a violation breaks. */
export type WorkflowRule = 'stack' | 'state' | 'secrets' | 'lock' | 'concurrency' | 'migrate';

export interface WorkflowViolation {
  rule: WorkflowRule;
  /** `<workflow file>#<job>`, `environment <name>` for a table secret no job reads, or `entries` for the module. */
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
  /** The secret holding each environment's deploy role ARN: `role-to-assume` reads exactly `${{ secrets.<it> }}`. */
  roleSecret: string;
  /**
   * The stacks whose program owns a database, and the step output (snake case, as `pebble-infra` writes it) holding
   * its URL; `false` for a product with no database.
   */
  database: false | { output: string; stacks: readonly StageKind[] };
  /**
   * For a module that exports `derive`: each variable it writes, with the variables it reads to do so. A derived
   * required entry is set only when all its sources are. `{ PG_RUNTIME_ROLE: ['DATABASE_RUNTIME_URL'] }`.
   */
  derived?: Readonly<Record<string, readonly string[]>>;
  /**
   * The stacks a job touches when the helper cannot read them (an expression, or a local action in a job holding
   * state credentials), by `<workflow file>#<job>`: `{ 'release.yml#deploy': ['prod'] }`.
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
  concurrency?: Concurrency;
  env: Record<string, string>;
  strategy?: { matrix?: unknown; 'max-parallel'?: unknown };
  steps: WorkflowStep[];
}

export interface Workflow {
  /** The file name without its directory, as violations name it. */
  file: string;
  concurrency?: Concurrency;
  env: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

/** `${{ x }}` with one space inside, however it was written. */
const canon = (value: string) => value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, '${{ $1 }}');
const text = (value: unknown): string => (typeof value === 'string' ? canon(value) : JSON.stringify(value));
const strings = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).map(([k, v]) => [k, text(v)]));
/** An `if:` without its optional `${{ }}` and with its whitespace collapsed. */
const bare = (value = '') =>
  value
    .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();

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
      ...(job.concurrency === undefined ? {} : { concurrency: concurrency(job.concurrency) }),
      env: strings(job.env),
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
  return {
    file,
    ...(raw.concurrency === undefined ? {} : { concurrency: concurrency(raw.concurrency) }),
    env: strings(raw.env),
    jobs,
  };
}

function read(path: string): { workflow: Workflow; raw: Record<string, any> } {
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, any>;
  return { workflow: normalize(basename(path), raw), raw };
}

/** Reads and parses one workflow file, with each job's steps, env and concurrency in one shape. */
export function loadWorkflow(path: string): Workflow {
  return read(path).workflow;
}

// One run of a job with its matrix values written in: what GitHub would run. `raw` is the job as written (with the
// workflow's own keys), for the secrets scan, so no field is lost to the normalized shape.
interface Variant {
  id: string;
  label: string;
  workflow: Workflow;
  key: string;
  job: WorkflowJob;
  raw: unknown;
  /** The job's `strategy.matrix` is not a literal mapping, so how many copies run is unknown. */
  opaque: boolean;
}

const EXPRESSION = /\$\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

function substitute<T>(value: T, binding: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(EXPRESSION, (whole, path: string) => binding[path] ?? whole) as T;
  if (Array.isArray(value)) return value.map((item) => substitute(item, binding)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, binding)])) as T;
  return value;
}

/** The legs of a literal matrix: list keys crossed, then `include` and `exclude`; undefined for any other matrix. */
function matrixLegs(matrix: unknown): Record<string, string>[] | undefined {
  if (matrix === undefined) return [{}];
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return undefined;
  const { include, exclude, ...keys } = matrix as Record<string, unknown>;
  const lists = [include ?? [], exclude ?? []];
  if (lists.some((list) => !Array.isArray(list) || list.some((entry) => !entry || typeof entry !== 'object')))
    return undefined;
  let legs: Record<string, string>[] = Object.keys(keys).length > 0 ? [{}] : [];
  for (const [key, values] of Object.entries(keys)) {
    if (!Array.isArray(values)) return undefined;
    legs = legs.flatMap((leg) => values.map((value) => ({ ...leg, [`matrix.${key}`]: text(value) })));
  }
  const prefixed = (entry: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(entry).map(([k, v]) => [`matrix.${k}`, text(v)]));
  for (const entry of (exclude ?? []) as Record<string, unknown>[]) {
    const wanted = prefixed(entry);
    legs = legs.filter((leg) => !Object.entries(wanted).every(([k, v]) => leg[k] === v));
  }
  const original = Object.keys(keys).map((k) => `matrix.${k}`);
  for (const entry of (include ?? []) as Record<string, unknown>[]) {
    const extra = prefixed(entry);
    const hit = legs.filter((leg) =>
      Object.entries(extra).every(([k, v]) => !original.includes(k) || !(k in leg) || leg[k] === v)
    );
    if (original.length > 0 && hit.length > 0) for (const leg of hit) Object.assign(leg, extra);
    else legs.push(extra);
  }
  return legs.length > 0 ? legs : [{}];
}

function variants({ workflow, raw }: { workflow: Workflow; raw: Record<string, any> }): Variant[] {
  const { jobs: _jobs, ...top } = raw;
  return Object.entries(workflow.jobs).flatMap(([key, job]) => {
    const legs = matrixLegs(job.strategy?.matrix);
    return (legs ?? [{}]).map((binding) => {
      const shown = Object.entries(binding).map(([k, v]) => `${k}=${v}`);
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
        raw: [top, raw.jobs[key]],
        opaque: legs === undefined,
      };
    });
  });
}

// `pebble-infra <verb> <stack> [flags]` as a workflow step runs it, or a declared local action (`verb: 'declared'`,
// taken to clear the lock).
interface Command {
  verb: string;
  stackArg?: string;
  flags: Set<string>;
  text: string;
  /** Run by the toolkit's `pulumi` action, whose step outputs come as one JSON object, `outputs.json`. */
  wrapped?: boolean;
}

const VALUE_FLAGS = new Set(['--entries', '--outputs', '--product', '--owner']);

function commands(run: string): Command[] {
  const found: Command[] = [];
  for (const line of run.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    for (const match of line.matchAll(/(?:^|[\s;&|(])pebble-infra\s+([^;&|#\n]*)/g)) {
      const [verb = '', ...rest] = [...match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(
        (m) => m[1] ?? m[2] ?? m[3]!
      );
      const flags = new Set<string>();
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i]!;
        if (!word.startsWith('--')) positionals.push(word);
        else if (VALUE_FLAGS.has(word)) i++;
        else if (!VALUE_FLAGS.has(word.split('=')[0]!)) flags.add(word);
      }
      const stackArg = verb === 'pg-database' ? undefined : positionals[0];
      found.push({
        verb,
        ...(stackArg === undefined ? {} : { stackArg }),
        flags,
        text: `pebble-infra ${match[1]!.trim()}`,
      });
    }
  }
  return found;
}

/** The toolkit's own actions, at any ref; GitHub matches the owner and repo in any case. */
const TOOLKIT = /^pebble-tech\/toolkit\//i;
const SETUP_ACTION = /^pebble-tech\/toolkit\/\.github\/actions\/setup@[^/\s]+$/i;
const PULUMI_ACTION = /^pebble-tech\/toolkit\/\.github\/actions\/pulumi@[^/\s]+$/i;
const PULUMI_INPUTS = new Set(['command', 'stack', 'entries', 'clear-lock', 'summary', 'infra']);

/** The `pebble-infra` command a `pulumi` action step runs, from its literal `with:` inputs; a string says why not. */
function wrapperCommand(step: WorkflowStep): Command | string {
  const { command, stack, entries, ...rest } = step.with;
  const unknown = Object.keys(rest).filter((key) => !PULUMI_INPUTS.has(key));
  if (unknown.length > 0) return `with ${unknown.join(', ')}, which the action does not take`;
  if (!['up', 'preview', 'remove'].includes(command ?? ''))
    return `command ${command ?? '(unset)'}, not up, preview or remove written as a literal`;
  if (stack === undefined) return 'no stack input';
  const flags = new Set<string>();
  for (const name of ['clear-lock', 'summary']) {
    const value = rest[name];
    if (value === 'true') flags.add(`--${name}`);
    else if (value !== undefined && value !== 'false')
      return `${name}: ${value}, not true or false written as a literal`;
  }
  const words = [command, stack, ...(entries === undefined ? [] : ['--entries', entries]), ...flags];
  return {
    verb: command!,
    stackArg: stack,
    flags,
    text: `pebble-infra ${words.join(' ')}`,
    wrapped: true,
  };
}

/** `pulumi <command>` run directly, other than logging in or reading the CLI's own state. */
function rawPulumi(run: string): string[] {
  const allowed = new Set(['login', 'logout', 'version', 'whoami', 'about', 'plugin']);
  return [...run.matchAll(/(?:^|[\s;&|(])pulumi\s+([a-z][\w-]*)/g)]
    .map((m) => m[1]!)
    .filter((command) => !allowed.has(command));
}

const stepEnv = (v: Variant, step: WorkflowStep) => ({ ...v.workflow.env, ...v.job.env, ...step.env });

/** The one expression a PR stack name or a PR group may hold. */
const PR_NUMBER = '${{ github.event.pull_request.number }}';
const KNOWN_STACK = /^(?:shared|staging|prod|pr-[1-9][0-9]*)$/;
const known = (stack: string) => KNOWN_STACK.test(stack) || stack === `pr-${PR_NUMBER}`;
const kindOf = (stack: string): StageKind => (stack.startsWith('pr-') ? 'preview' : (stack as StageKind));

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
const isCredentials = (step: WorkflowStep) => step.uses?.startsWith('aws-actions/configure-aws-credentials@') ?? false;

interface Context {
  options: WorkflowChecks;
  variants: Variant[];
  touches: Touch[];
  add: (rule: WorkflowRule, job: string, message: string) => void;
}

function collectTouches(context: Context): void {
  const { options, add } = context;
  for (const variant of context.variants) {
    const { steps } = variant.job;
    const declared = options.stacks?.[variant.id];
    for (const name of declared ?? []) {
      if (!known(name)) add('stack', variant.id, `${variant.id} is declared to touch "${name}", not a stack name`);
    }
    const stacksOf = (found: string | undefined) => (found ? [found] : (declared ?? []).filter(known));
    const holdsState = steps.some((step) => isCredentials(step) || 'PULUMI_BACKEND_URL' in stepEnv(variant, step));
    steps.forEach((step, index) => {
      const push = (command: Command, stack: string) =>
        context.touches.push({ variant, index, step, command, stack, kind: kindOf(stack) });
      if (holdsState && step.uses?.startsWith('./')) {
        if (!declared) {
          add(
            'stack',
            variant.id,
            `${variant.label} step ${stepName(step, index)} runs the local action ${step.uses} in a job holding state credentials; declare the stacks it touches in the \`stacks\` option under "${variant.id}"`
          );
        }
        const command = { verb: 'declared', flags: new Set(['--clear-lock']), text: `uses: ${step.uses}` };
        for (const stack of stacksOf(undefined)) push(command, stack);
      }
      const found = step.run ? commands(step.run) : [];
      if (step.uses && TOOLKIT.test(step.uses) && !SETUP_ACTION.test(step.uses)) {
        const wrapped = PULUMI_ACTION.test(step.uses)
          ? wrapperCommand(step)
          : 'a toolkit path the helper does not read';
        if (typeof wrapped === 'string') {
          add(
            'stack',
            variant.id,
            `${variant.label} step ${stepName(step, index)} runs ${step.uses}: ${wrapped}. The helper reads the toolkit's setup action, and its pulumi action with a literal command, stack, entries, clear-lock, summary and infra`
          );
        } else found.push(wrapped);
      }
      for (const command of rawPulumi(step.run ?? '')) {
        add(
          'stack',
          variant.id,
          `${variant.label} step ${stepName(step, index)} runs \`pulumi ${command}\` directly; run it through pebble-infra, whose stack and lock the checks read`
        );
      }
      for (const command of found) {
        if (command.stackArg === undefined) continue;
        const stacks = stacksOf(known(command.stackArg) ? command.stackArg : undefined);
        if (stacks.length === 0) {
          add(
            'stack',
            variant.id,
            `${variant.label} step ${stepName(step, index)} runs \`${command.text}\` and its stack is not shared, staging, prod, pr-<n> or "pr-${PR_NUMBER}" written in the command; declare it in the \`stacks\` option under "${variant.id}"`
          );
        }
        for (const stack of stacks) push(command, stack);
      }
    });
    if (variant.opaque && context.touches.some((t) => t.variant === variant)) {
      add(
        'stack',
        variant.id,
        `${variant.label} touches a stack under a strategy.matrix that is not a literal mapping, so how many copies run at once is unknown`
      );
    }
  }
  // A literal pr-<n> and the PR form can name the same stack under different groups.
  const literal = context.touches.find((t) => /^pr-\d/.test(t.stack));
  const form = context.touches.find((t) => t.stack === `pr-${PR_NUMBER}`);
  if (literal && form) {
    add(
      'stack',
      literal.variant.id,
      `${literal.variant.label} touches ${literal.stack} while ${form.variant.label} touches pr-${PR_NUMBER}, which can be the same stack; use one form`
    );
  }
}

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
    const role = variant.job.steps[credentials]?.with['role-to-assume'];
    if (credentials < 0 || credentials > index) {
      add(
        'state',
        variant.id,
        `${variant.label} touches ${stack} before any aws-actions/configure-aws-credentials step`
      );
    } else if (role !== `\${{ secrets.${options.roleSecret} }}`) {
      add(
        'state',
        variant.id,
        `${variant.label} assumes role-to-assume ${role || '(none)'}, not \`\${{ secrets.${options.roleSecret} }}\``
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

const ALWAYS_SET = new Set(['GITHUB_TOKEN']);
const viaValues = (env: Record<string, string>) => env.PEBBLE_INFRA_VALUES === '${{ toJSON(secrets) }}';

/** The variables a `pebble-infra` command reads from its values: entries for configure, up and preview, and the admin URL of a preview database. */
function valuesNeeded(module: EntriesModule, command: Command, kind: StageKind) {
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
  const derived = options.derived ?? {};
  if (options.entries.derive && !options.derived) {
    add('secrets', 'entries', 'the entries module exports derive: declare what it writes and reads in `derived`');
  }
  const read: Record<string, Set<string>> = {};
  for (const variant of variants) {
    const environment = variant.job.environment;
    // Inside each `${{ }}` of the job as written, `secrets` is either `secrets.NAME` or the whole `toJSON(secrets)`.
    const explicit: string[] = [];
    for (const [, body] of JSON.stringify(variant.raw).matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      if (body!.trim() === 'toJSON(secrets)') continue;
      for (const [use, , name] of body!.matchAll(/\bsecrets\b(\.([A-Za-z_]\w*))?/g)) {
        if (!name) add('secrets', variant.id, `${variant.label} reads ${use} other than as secrets.NAME`);
        else if (!ALWAYS_SET.has(name)) explicit.push(name);
      }
    }
    const usesValues = variant.job.steps.some((step) => viaValues(stepEnv(variant, step)));
    if ((explicit.length === 0 && !usesValues) || environment === undefined) continue;
    const table = options.secrets[environment];
    if (!table) {
      add('secrets', variant.id, `${variant.label} reads secrets in environment ${environment}, which has no table`);
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
    // toJSON(secrets) on a step that runs no pebble-infra command hands it every secret.
    for (const step of variant.job.steps) {
      if (viaValues(stepEnv(variant, step)) && !touches.some((t) => t.variant === variant && t.step === step))
        for (const name of table) seen.add(name);
    }
  }

  for (const { variant, step, index, command, kind } of touches) {
    const environment = variant.job.environment;
    const table = environment === undefined ? undefined : options.secrets[environment];
    const scope = stepEnv(variant, step);
    const values = viaValues(scope);
    const { required, read: wanted } = valuesNeeded(options.entries, command, kind);
    const credentials = variant.job.steps.findIndex(isCredentials);
    // A value counts as the CLI counts it: trimmed, and a derived variable only from its sources.
    const given = new Set([
      ...Object.entries(scope)
        .filter(([name, value]) => name !== 'PEBBLE_INFRA_VALUES' && value.trim() !== '')
        .map(([name]) => name),
      ...(values && table ? table : []),
      ...(credentials >= 0 && credentials < index && variant.job.steps[credentials]!.with['aws-region']?.trim()
        ? ['AWS_REGION']
        : []),
    ]);
    const has = (name: string) => (derived[name] ? derived[name].every((s) => given.has(s)) : given.has(name));
    if (values && table && environment) {
      const seen = (read[environment] ??= new Set());
      for (const name of wanted.flatMap((n) => [n, ...(derived[n] ?? [])])) if (table.includes(name)) seen.add(name);
    }
    const missing = required.filter((name) => !has(name));
    if (missing.length > 0) {
      add(
        'secrets',
        variant.id,
        `${variant.label} step ${stepName(step, index)} runs \`${command.text}\`, which needs ${missing.join(', ')}; ${values ? `environment ${environment ?? '(none)'} does not set ${missing.length === 1 ? 'it' : 'them'} (or ${missing.length === 1 ? 'its' : 'their'} derived sources) and the step's env does not either` : "the step's env does not set them and it has no PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}"}`
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
 * holds one literal group, and none may cancel in progress. Every job on one `pr-<n>` stack holds one group, which may
 * cancel and may be keyed on the PR number. `preview` and `prepare --preview-only` never clear a lock.
 */
function lockRule({ touches, add }: Context): void {
  for (const { variant, command, stack } of touches) {
    if (isPreview(command) && command.flags.has('--clear-lock')) {
      add('lock', variant.id, `${variant.label} runs \`${command.text}\`: a preview never clears a lock (${stack})`);
    }
  }
  for (const stack of new Set(touches.map((t) => t.stack))) {
    const onStack = touches.filter((t) => t.stack === stack);
    const preview = stack.startsWith('pr-');
    const jobs = unique(onStack);
    const clearers = unique(onStack.filter(clears));
    if (!preview && clearers.length === 0) continue;
    for (const variant of jobs) {
      const group = groupOf(variant)?.group ?? '';
      if ((preview ? group.replaceAll(PR_NUMBER, '') : group).includes('${{')) {
        add(
          'lock',
          variant.id,
          `${variant.label} holds group ${group} on ${stack}; the helper cannot tell which runs share it: write it as a literal${preview ? ` (keyed on ${PR_NUMBER} at most)` : ''}`
        );
      }
      if (!preview && [variant.job.concurrency, variant.workflow.concurrency].some(cancels)) {
        add('lock', variant.id, `${variant.label} runs on ${stack} in a group that may cancel in progress`);
      }
    }
    if (preview) {
      const group = reference(jobs);
      for (const variant of jobs) {
        const own = groupOf(variant)?.group;
        if (!own || own !== group) {
          add(
            'lock',
            variant.id,
            `${variant.label} runs on ${stack} in group ${own || '(none)'}, not ${group ?? '(none)'}: every job on one pr-<n> stack, remove included, shares that pull request's one concurrency group`
          );
        }
      }
    }
    const why = `every job passing --clear-lock on ${stack} shares one never-cancelled group with every other job on ${stack}`;
    for (const clearer of preview ? [] : clearers) {
      const own = groupOf(clearer)?.group;
      const outside = jobs.filter((other) => other !== clearer && groupOf(other)?.group !== own);
      if (!own) {
        add(
          'lock',
          clearer.id,
          `${clearer.label} passes --clear-lock on ${stack} in no concurrency group, so two of its runs can clear each other's lock: ${why}`
        );
      } else if (outside.length > 0) {
        add(
          'lock',
          clearer.id,
          `${clearer.label} passes --clear-lock on ${stack} in group ${own}, which ${outside.map((o) => `${o.label} (${groupOf(o)?.group || 'no group'})`).join(', ')} does not hold: ${why}`
        );
      }
    }
    // Two jobs of one run, matrix copies included, run side by side unless a job-level group, `needs` or
    // `max-parallel: 1` serialises them; the workflow's group serialises runs, not jobs.
    for (const [i, a] of jobs.entries()) {
      for (const b of jobs.slice(i + 1)) {
        if (a.workflow.file !== b.workflow.file || a.job.concurrency || b.job.concurrency) continue;
        if (a.key === b.key ? String(a.job.strategy?.['max-parallel']) === '1' : ordered(a.workflow, a.key, b.key))
          continue;
        add(
          'lock',
          b.id,
          `${b.label} and ${a.label} run on ${stack} in one workflow run with only the workflow's group between them; give the job a job-level group, order them with needs, or set max-parallel: 1`
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
  for (const stack of new Set(touches.filter((t) => t.kind !== 'preview').map((t) => t.stack))) {
    const onStack = touches.filter((t) => t.stack === stack);
    const jobs = [...new Map(onStack.map((t) => [t.variant.id, t.variant])).values()];
    if (!onStack.some(clears) || jobs.length < 2) continue;
    for (const variant of jobs) {
      if (groupOf(variant)?.queue !== 'max') {
        const others = jobs.filter((v) => v.id !== variant.id).map((v) => v.id);
        add(
          'concurrency',
          variant.id,
          `${variant.label} shares ${stack} with ${others.join(', ')}, and its group ${groupOf(variant)?.group ?? '(none)'} does not set queue: max, so a newer run can drop a pending one`
        );
      }
    }
  }
}

const references = (step: WorkflowStep, expression: string) =>
  JSON.stringify({ run: step.run, env: step.env, with: step.with }).includes(expression);

/**
 * In each deploying job, an unconditional `pebble-infra outputs <stack> --github-output --if-exists` in that same job
 * comes first; a read in another job does not count. Every step between it and `up` that reads the URL runs
 * under exactly `if: <read> != ''`, and a step after `up` under exactly `if: <read> == ''` migrates the first deploy
 * from `up`'s own output. Any other condition fails.
 */
function migrateRule({ options, touches, add }: Context): void {
  if (!options.database) return;
  const { output, stacks } = options.database;
  const isRead = (t: Touch, stack: string) =>
    t.command.verb === 'outputs' &&
    t.stack === stack &&
    t.command.flags.has('--if-exists') &&
    t.command.flags.has('--github-output');
  for (const up of touches.filter((t) => t.command.verb === 'up' && stacks.includes(t.kind))) {
    const { variant, stack, index } = up;
    const steps = variant.job.steps;
    const reads: { expression: string; from: number; step: WorkflowStep }[] = [];
    steps.forEach((step, i) => {
      const touch = touches.find((t) => t.variant === variant && t.step === step && isRead(t, stack));
      if (i < index && step.id && touch)
        reads.push({ expression: `steps.${step.id}.outputs.${output}`, from: i + 1, step });
    });
    const fail = (message: string) => add('migrate', variant.id, `${variant.label} ${message}`);
    const migrate = reads.flatMap(({ expression, from }) =>
      steps
        .slice(from, index)
        .filter((step) => references(step, expression))
        .map((step) => ({ step, expression }))
    );
    if (migrate.length === 0) {
      fail(
        `runs \`${up.command.text}\` (step ${stepName(up.step, index)}) before any step in this job reads ${stack}'s ${output}: read it first with \`pebble-infra outputs ${stack} --github-output --if-exists\` and migrate before up`
      );
      continue;
    }
    for (const { step } of reads.filter((r) => r.step.if !== undefined)) {
      fail(`reads ${stack}'s ${output} under if: ${step.if}; the read runs unconditionally`);
    }
    for (const { step, expression } of migrate.filter(
      ({ step, expression }) => bare(step.if) !== `${expression} != ''`
    )) {
      fail(
        `migrates ${stack} before up under if: ${step.if ?? '(none)'}; the guard is exactly \`if: ${expression} != ''\``
      );
    }
    const expression = migrate[0]!.expression;
    // The pulumi action hands on every output pebble-infra wrote as one JSON object.
    const id = up.step.id ?? '<up id>';
    const fromUp = up.command.wrapped
      ? `fromJSON(steps.${id}.outputs.json).${output}`
      : `steps.${id}.outputs.${output}`;
    const first = steps
      .slice(index + 1)
      .some((step) => up.step.id && references(step, fromUp) && bare(step.if) === `${expression} == ''`);
    if (!first) {
      fail(
        `never migrates ${stack}'s first deploy: after up (which needs an id), add a step under exactly \`if: ${expression} == ''\` that reads ${fromUp}`
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
    variants: options.workflows.map(read).flatMap(variants),
    touches: [],
    add,
  };
  collectTouches(context);
  for (const rule of RULES) rule(context);
  return violations;
}
