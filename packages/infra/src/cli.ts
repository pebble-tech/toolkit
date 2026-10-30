// `pebble-infra`: the stack steps a product's workflows run around `pulumi up`, from the directory holding the
// product's Pulumi.yaml (`pnpm --dir infra exec pebble-infra <command>`).
//
//   prepare <stack> [--preview-only] [--clear-lock]   select or create the stack, reset a broken preview stack
//   configure <stack> --entries <module>              write the stack config from the product's entries module
//   up <stack> --entries <module> [--clear-lock]      prepare, configure, pulumi up, outputs to $GITHUB_OUTPUT
//   preview <stack> --entries <module> [--summary]    prepare --preview-only, configure, pulumi preview --diff
//   outputs <stack> [--github-output] [--if-exists]   the stack's outputs, before or after up
//   remove pr-<n> [--clear-lock]                      destroy a preview stack and leave nothing in its state path
//   pg-database <drop|check> <name> [--owner <role>]  drop a database and its role, or check that the admin could
//
// The product id is Pulumi.yaml's `name` unless --product names it; the outputs export is `outputs` unless --outputs
// names it. prepare, up, preview and remove read PULUMI_BACKEND_URL and PULUMI_SECRETS_PROVIDER (log in first). Values
// for the config entries and PG_ADMIN_URL come from PEBBLE_INFRA_VALUES (a JSON object, such as `toJSON(secrets)`)
// first, then the environment; no child process sees PEBBLE_INFRA_VALUES.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { ConfigValues, EntriesModule } from './config.js';
import { assertProduct } from './names.js';
import {
  configure,
  pgDatabaseArgs,
  prepare,
  processRunner,
  processStreamer,
  pulumiUp,
  remove,
  stackOutputs,
  type StackContext,
  type StackOutput,
} from './stack.js';

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  /** The directory holding Pulumi.yaml. */
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function processIo(): CliIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

const VALUES = 'PEBBLE_INFRA_VALUES';

const FLAGS = {
  'preview-only': { type: 'boolean' },
  'clear-lock': { type: 'boolean' },
  entries: { type: 'string' },
  product: { type: 'string' },
  outputs: { type: 'string' },
  'github-output': { type: 'boolean' },
  'if-exists': { type: 'boolean' },
  summary: { type: 'boolean' },
  owner: { type: 'string' },
} as const;

type Flag = keyof typeof FLAGS;

/** Each command's flags; `entries` is required where it is listed. */
const COMMANDS: Record<string, readonly Flag[]> = {
  prepare: ['preview-only', 'clear-lock', 'product'],
  configure: ['entries', 'product'],
  up: ['entries', 'clear-lock', 'product', 'outputs'],
  preview: ['entries', 'summary', 'product'],
  outputs: ['outputs', 'github-output', 'if-exists'],
  remove: ['clear-lock', 'product'],
  'pg-database': ['owner'],
};

const USAGE = `usage: pebble-infra <command> <stack> [flags]
  prepare <stack> [--preview-only | --clear-lock]
  configure <stack> --entries <module>
  up <stack> --entries <module> [--clear-lock] [--outputs <name>]
  preview <stack> --entries <module> [--summary]
  outputs <stack> [--github-output] [--if-exists] [--outputs <name>]
  remove pr-<n> [--clear-lock]
  pg-database <drop|check> <name> [--owner <role>]
  --product <id> overrides Pulumi.yaml's name for prepare, configure, up, preview and remove
`;

class UsageError extends Error {}

/**
 * `PEBBLE_INFRA_VALUES` as a JSON object of strings, or `{}` when unset. Refused when it is anything else; the
 * message never repeats the value.
 */
function readValues(env: CliIo['env']): ConfigValues {
  const raw = env[VALUES];
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${VALUES} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${VALUES} must be a JSON object of variable names to values`);
  }
  const nonString = Object.entries(parsed).filter(([, value]) => typeof value !== 'string');
  if (nonString.length > 0) {
    throw new Error(`${VALUES} values must be strings: ${nonString.map(([key]) => key).join(', ')}`);
  }
  return parsed as ConfigValues;
}

/** Pulumi.yaml's `name`, the product id unless `--product` names it. */
function projectName(cwd: string): string {
  const file = join(cwd, 'Pulumi.yaml');
  if (!existsSync(file))
    throw new Error(`no Pulumi.yaml in ${cwd}: run from the directory holding it, or pass --product`);
  const match = /^name:[ \t]*["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/m.exec(readFileSync(file, 'utf8'));
  if (!match) throw new Error(`${file} has no name`);
  return match[1]!;
}

const KINDS = new Set(['preview', 'staging', 'prod', 'shared']);

/** The product's entries module, compiled; refused when it does not have the shape `EntriesModule` describes. */
async function loadEntries(cwd: string, path: string): Promise<EntriesModule> {
  const loaded = (await import(pathToFileURL(resolve(cwd, path)).href)) as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new Error(`${path}: ${what}`);
  };
  const { entries, derive, namespace } = loaded;
  if (!Array.isArray(entries)) return fail('exports no `entries` array');
  entries.forEach((entry: Record<string, unknown> | null, index) => {
    const valid =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.key === 'string' &&
      entry.key !== '' &&
      typeof entry.env === 'string' &&
      entry.env !== '' &&
      typeof entry.secret === 'boolean' &&
      typeof entry.required === 'boolean' &&
      Array.isArray(entry.stacks) &&
      entry.stacks.every((kind) => KINDS.has(kind as string));
    if (!valid) fail(`entries[${index}] is not an Entry ({ key, env, secret, required, stacks })`);
  });
  if (derive !== undefined && typeof derive !== 'function') fail('`derive` is not a function');
  if (namespace !== undefined && (typeof namespace !== 'string' || namespace === '')) fail('`namespace` is not a name');
  return { entries, derive, namespace } as EntriesModule;
}

/** `databaseUrl` → `database_url`: a camelCase output key as a snake_case step output name. */
const outputName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Appends the outputs to `$GITHUB_OUTPUT`. Every line of every secret value is masked on stdout first, so the runner
 * hides it before any later step can print it; a value with a line break uses the heredoc form.
 */
function writeGithubOutput(outputs: StackOutput[], file: string, stdout: (text: string) => void): void {
  for (const output of outputs.filter((o) => o.secret)) {
    for (const line of output.value.split(/\r?\n/)) if (line.trim()) stdout(`::add-mask::${line}\n`);
  }
  const text = outputs
    .map(({ key, value }) => {
      if (!/[\r\n]/.test(value)) return `${outputName(key)}=${value}\n`;
      const delimiter = `ghadelimiter_${randomUUID()}`;
      return `${outputName(key)}<<${delimiter}\n${value}\n${delimiter}\n`;
    })
    .join('');
  appendFileSync(file, text);
}

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const allowed = COMMANDS[command ?? ''];
  if (!command || !allowed) throw new UsageError(`unknown command ${command ?? '(none)'}`);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: FLAGS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values: flags, positionals } = parsed;
  const extra = (Object.keys(flags) as Flag[]).filter((flag) => !allowed.includes(flag));
  if (extra.length > 0) throw new UsageError(`${command} takes no ${extra.map((flag) => `--${flag}`).join(', ')}`);
  const arity = command === 'pg-database' ? 2 : 1;
  if (positionals.length !== arity)
    throw new UsageError(`${command} takes ${arity === 1 ? 'a stack' : 'drop|check and a name'}`);
  if (allowed.includes('entries') && !flags.entries) throw new UsageError(`${command} needs --entries <module>`);
  if (flags['preview-only'] && flags['clear-lock']) throw new UsageError('--preview-only never clears a lock');
  return { command, stack: positionals[0]!, positionals, flags };
}

/** Runs one command; resolves to the process exit code (2 for a usage error). */
export async function main(argv: string[], io: CliIo = processIo()): Promise<number> {
  const log = (line: string) => io.stderr(`${line}\n`);
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    log((error as Error).message);
    io.stderr(USAGE);
    return 2;
  }
  const { command, stack, positionals, flags } = parsed;
  try {
    const values = readValues(io.env);
    const childEnv: NodeJS.ProcessEnv = { ...io.env };
    delete childEnv[VALUES];
    if (values.PG_ADMIN_URL !== undefined) childEnv.PG_ADMIN_URL = values.PG_ADMIN_URL;
    const run = processRunner({ cwd: io.cwd, env: childEnv });
    const outputsName = flags.outputs ?? 'outputs';
    const product = () => {
      const id = flags.product ?? projectName(io.cwd);
      assertProduct(id);
      return id;
    };
    const context = (): StackContext => {
      const backendUrl = io.env.PULUMI_BACKEND_URL?.trim();
      const secretsProvider = io.env.PULUMI_SECRETS_PROVIDER?.trim();
      if (!backendUrl || !secretsProvider)
        throw new Error('PULUMI_BACKEND_URL and PULUMI_SECRETS_PROVIDER are required');
      return { run, projectDir: io.cwd, product: product(), backendUrl, secretsProvider, log };
    };
    const writeConfig = async () =>
      configure(run, stack, await loadEntries(io.cwd, flags.entries!), { ...io.env, ...values }, product(), log);
    const stream = processStreamer({ cwd: io.cwd, env: childEnv, stdout: io.stdout, stderr: io.stderr });

    switch (command) {
      case 'prepare':
        log(
          `stack ${stack}: ${prepare(context(), stack, { previewOnly: flags['preview-only'], clearLock: flags['clear-lock'] })}`
        );
        return 0;
      case 'configure':
        await writeConfig();
        return 0;
      case 'up': {
        const ctx = context();
        log(`stack ${stack}: ${prepare(ctx, stack, { clearLock: flags['clear-lock'] })}`);
        await writeConfig();
        await pulumiUp(stream, stack, log, io.sleep);
        if (io.env.GITHUB_OUTPUT) {
          const outputs = stackOutputs(run, stack, outputsName, { ifExists: true });
          if (outputs) writeGithubOutput(outputs, io.env.GITHUB_OUTPUT, io.stdout);
          else log(`stack ${stack} has no output named ${outputsName}; nothing written to GITHUB_OUTPUT`);
        }
        return 0;
      }
      case 'preview': {
        if (flags.summary && !io.env.GITHUB_STEP_SUMMARY) throw new Error('--summary needs GITHUB_STEP_SUMMARY');
        log(`stack ${stack}: ${prepare(context(), stack, { previewOnly: true })}`);
        await writeConfig();
        const result = await stream('pulumi', ['preview', '--diff', '--color', 'never', '--stack', stack]);
        if (flags.summary) {
          const sha = io.env.GITHUB_SHA ? ` (${io.env.GITHUB_SHA})` : '';
          const block = `### pulumi preview -s ${stack}${sha}\n\`\`\`diff\n${result.output.replace(/\n?$/, '\n')}\`\`\`\n`;
          appendFileSync(io.env.GITHUB_STEP_SUMMARY!, block);
        }
        if (!result.ok) throw new Error(`pulumi preview -s ${stack} failed`);
        return 0;
      }
      case 'outputs': {
        if (flags['github-output'] && !io.env.GITHUB_OUTPUT) throw new Error('--github-output needs GITHUB_OUTPUT');
        const outputs = stackOutputs(run, stack, outputsName, { ifExists: flags['if-exists'] });
        if (!outputs) {
          log(`stack ${stack} has no output ${outputsName} yet`);
          return 0;
        }
        if (flags['github-output']) writeGithubOutput(outputs, io.env.GITHUB_OUTPUT!, io.stdout);
        else {
          const shown = Object.fromEntries(outputs.map((o) => [o.key, o.secret ? '[secret]' : o.value]));
          io.stdout(`${JSON.stringify(shown, null, 2)}\n`);
        }
        return 0;
      }
      case 'remove':
        remove(context(), stack, { clearLock: flags['clear-lock'] });
        return 0;
      default: {
        const owner = flags.owner === undefined ? [] : ['--owner', flags.owner];
        const result = spawnSync('node', pgDatabaseArgs([...positionals, ...owner]), {
          cwd: io.cwd,
          env: childEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        io.stdout(result.stdout ?? '');
        io.stderr(result.stderr ?? String(result.error ?? ''));
        return result.status ?? 1;
      }
    }
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
