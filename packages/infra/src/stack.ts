// The stack steps a product's workflows run around `pulumi up`. Every product fact comes from the context (product id,
// backend, secrets provider); `pebble-infra` (cli.ts) builds it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configWrites, type ConfigValues, type EntriesModule } from './config.js';
import { databaseName, stackKind } from './names.js';

/** Runs a command; `ok: false` when it exits non-zero. Commands run from the directory holding Pulumi.yaml. */
export type Runner = (
  command: string,
  args: string[],
  options?: { input?: string }
) => { ok: boolean; stdout: string; stderr: string };

/** Runs a command with its output passed through as it arrives, and returns that output too. */
export type Streamer = (command: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** A Runner over real processes, capturing output. */
export function processRunner(options: ProcessOptions = {}): Runner {
  return (command, args, run) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      input: run?.input,
      stdio: [run?.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? String(result.error ?? ''),
    };
  };
}

/** A Streamer over real processes: stdout and stderr go to `write` as they arrive. */
export function processStreamer(
  options: ProcessOptions & { stdout: (text: string) => void; stderr: (text: string) => void }
): Streamer {
  return (command, args) =>
    new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (text: string) => {
        output += text;
        options.stdout(text);
      });
      child.stderr.setEncoding('utf8').on('data', (text: string) => {
        output += text;
        options.stderr(text);
      });
      child.on('error', (error) => {
        options.stderr(`${error.message}\n`);
        resolve({ ok: false, output: `${output}${error.message}` });
      });
      child.on('close', (code) => resolve({ ok: code === 0, output }));
    });
}

export interface StackContext {
  run: Runner;
  /** Directory holding Pulumi.yaml and the stack config files. */
  projectDir: string;
  /** Product id; names the preview database (`<product>_pr_<n>`), as `Stage` does. */
  product: string;
  /** `s3://<bucket>/<path>?region=…`, the backend `pulumi login` used. */
  backendUrl: string;
  /** `awskms://alias/…?region=…`, the key new stacks encrypt their secrets with. */
  secretsProvider: string;
  log: (line: string) => void;
}

interface StateResource {
  type?: string;
}

/** The part of `pulumi stack export`'s `deployment` these steps read. */
interface Deployment {
  resources?: StateResource[];
  pending_operations?: { resource?: StateResource; type?: string }[];
  secrets_providers?: { type?: string; state?: { url?: string; encryptedkey?: string } };
}

/** The pg-database script (drop and check); run with `node`, never imported. */
const PG_DATABASE = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? './pg-database.ts' : './pg-database.js', import.meta.url)
);

/** Arguments for `node` to run the package's pg-database script. */
export function pgDatabaseArgs(args: string[]): string[] {
  return [PG_DATABASE, ...args];
}

function must(ctx: StackContext, args: string[], input?: string): string {
  const result = ctx.run('pulumi', args, input === undefined ? undefined : { input });
  if (!result.ok) throw new Error(`pulumi ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function exists(ctx: StackContext, stack: string): boolean {
  return ctx.run('pulumi', ['stack', 'select', stack]).ok;
}

function deployment(ctx: StackContext, stack: string): Deployment {
  return (JSON.parse(must(ctx, ['stack', 'export', '--stack', stack])) as { deployment?: Deployment }).deployment ?? {};
}

function init(ctx: StackContext, stack: string): void {
  must(ctx, ['stack', 'init', stack, '--secrets-provider', ctx.secretsProvider]);
}

function clearLock(ctx: StackContext, stack: string): void {
  ctx.run('pulumi', ['cancel', '--yes', '--stack', stack]);
}

/**
 * What a preview stack may hold for the reset to start it again with `stack rm --force`: the database, its role and
 * password, the Stage and Database components, and their providers. The SQL drop removes all of it.
 */
const DATABASE_CLOSURE =
  /^(pulumi:pulumi:Stack|pulumi:providers:(postgresql|random)|postgresql:.+|random:.+|pebbletech:index:(Stage|Database))$/;

/** Every type in the state, or in an operation still pending, outside the database closure; untyped counts. */
function foreignTypes(state: Deployment): string[] {
  const resources = [...(state.resources ?? []), ...(state.pending_operations ?? []).map((op) => op.resource ?? {})];
  const types = resources.map((resource) => resource.type ?? '(a resource with no type)');
  return [...new Set(types.filter((type) => !DATABASE_CLOSURE.test(type)))].sort();
}

/**
 * `<product>_pr_<n>` and its role, dropped with the admin URL in PG_ADMIN_URL; a no-op when neither exists. Throws,
 * before any state is removed, when that admin has no authority over them (another admin created the role): the
 * script's line names who has.
 */
function dropPreviewDatabase(ctx: StackContext, stack: string): void {
  const database = databaseName(ctx.product, stack);
  const result = ctx.run('node', pgDatabaseArgs(['drop', database]));
  if (!result.ok) throw new Error(`dropping ${database} failed:\n${result.stderr}`);
  ctx.log(`dropped ${database} and its role if they existed`);
}

/** Fails before `pulumi up` when PG_ADMIN_URL's admin could not manage, and so could not later drop, the database. */
function checkPreviewDatabase(ctx: StackContext, stack: string): void {
  const database = databaseName(ctx.product, stack);
  const result = ctx.run('node', pgDatabaseArgs(['check', database]));
  if (!result.ok) throw new Error(`${database} cannot be managed with this PG_ADMIN_URL:\n${result.stderr}`);
}

/**
 * A fresh checkout has no Pulumi.<stack>.yaml, so the KMS-encrypted data key that encrypts the stack's secrets would
 * be missing. The state carries the same key: copy it back before anything writes config.
 */
function restoreSecretsConfig(ctx: StackContext, stack: string, state: Deployment): void {
  const file = join(ctx.projectDir, `Pulumi.${stack}.yaml`);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^encryptedkey:/m.test(current)) return;
  const provider = state.secrets_providers;
  if (provider?.type !== 'cloud' || !provider.state?.url || !provider.state.encryptedkey) {
    throw new Error(`stack ${stack} has no cloud secrets provider in its state to restore`);
  }
  const lines = `secretsprovider: ${provider.state.url}\nencryptedkey: ${provider.state.encryptedkey}\n`;
  writeFileSync(file, current ? `${current.replace(/\n?$/, '\n')}${lines}` : lines);
  ctx.log(`restored the secrets provider of ${stack} from its state`);
}

export interface PrepareOptions {
  /** For a run that only previews: select the stack and restore its key; never clear, create, remove or reset. */
  previewOnly?: boolean;
  /** Clear the lock a cancelled run left (`pulumi cancel`). Only a job that owns the stack's lock asks for this. */
  clearLock?: boolean;
}

/**
 * Leaves `stack` selected and ready for `pulumi up`. A run cancelled mid-update leaves a lock (cleared here only with
 * `clearLock`) and possibly pending operations. A preview stack with pending operations, or with no resources (a run
 * cancelled between `stack init` and `up`, or a database left by an earlier workflow), starts again from nothing when
 * all it holds is the database closure, which the SQL drop removes; anything else in it (a Worker, a Vercel project)
 * stops the reset by type. A long-lived stack with pending operations stops for a human (`pulumi refresh`); one that
 * was created but never updated is created again.
 *
 * `previewOnly` never clears a lock and never creates, removes or recreates the stack; it only selects it and restores
 * its key, and refuses a stack that is missing, never updated or has pending operations.
 */
export function prepare(ctx: StackContext, stack: string, options: PrepareOptions = {}): 'created' | 'reset' | 'ready' {
  if (options.previewOnly && options.clearLock) throw new Error('a preview never clears a lock');
  const preview = stackKind(stack) === 'preview';
  const present = exists(ctx, stack);
  if (options.previewOnly && !present) {
    throw new Error(
      `stack ${stack} does not exist; a preview does not create it (the deploying run does: pebble-infra prepare ${stack})`
    );
  }
  if (!present) {
    if (preview) dropPreviewDatabase(ctx, stack);
    init(ctx, stack);
    ctx.log(`created stack ${stack}`);
    return 'created';
  }
  if (options.previewOnly) {
    const state = deployment(ctx, stack);
    if ((state.pending_operations?.length ?? 0) > 0) {
      throw new Error(
        `stack ${stack} has pending operations from an interrupted update; a preview does not clear them`
      );
    }
    if ((state.resources?.length ?? 0) === 0) {
      throw new Error(
        `stack ${stack} was never updated; a preview does not recreate it (the deploying run does: pebble-infra prepare ${stack})`
      );
    }
    restoreSecretsConfig(ctx, stack, state);
    return 'ready';
  }
  if (options.clearLock) clearLock(ctx, stack);
  const state = deployment(ctx, stack);
  const pending = state.pending_operations?.length ?? 0;
  const resources = state.resources?.length ?? 0;
  if (preview && (pending > 0 || resources === 0)) {
    const foreign = foreignTypes(state);
    if (foreign.length > 0) {
      throw new Error(
        `stack ${stack} holds ${foreign.join(', ')}, beyond its database; a reset would leave ${foreign.length === 1 ? 'it' : 'them'} running. Run \`pulumi refresh -s ${stack}\` and check each pending operation, or remove the preview (pebble-infra remove ${stack})`
      );
    }
    // The drop first: if it is refused, the state stays for an authorized cleanup.
    dropPreviewDatabase(ctx, stack);
    must(ctx, ['stack', 'rm', stack, '--force', '--yes', '--remove-backups']);
    init(ctx, stack);
    ctx.log(`reset stack ${stack} (${pending} pending operations, ${resources} resources)`);
    return 'reset';
  }
  if (pending > 0) {
    throw new Error(
      `stack ${stack} has ${pending} pending operations from an interrupted update; run \`pulumi refresh -s ${stack}\` and check each one`
    );
  }
  if (resources === 0) {
    // Created but never updated (prod created by an earlier run that only previewed): no resource to lose, and no key in
    // the state.
    must(ctx, ['stack', 'rm', stack, '--yes', '--remove-backups']);
    init(ctx, stack);
    ctx.log(`created stack ${stack} again: it was never updated`);
    return 'reset';
  }
  if (preview) checkPreviewDatabase(ctx, stack);
  restoreSecretsConfig(ctx, stack, state);
  return 'ready';
}

/**
 * Removes a preview stack and everything it made, whatever state an earlier run left: never created, locked (with
 * `clearLock`), interrupted mid-update, or complete. Ends by checking that no object for the stack is left in the
 * state path.
 */
export function remove(ctx: StackContext, stack: string, options: { clearLock?: boolean } = {}): void {
  if (stackKind(stack) !== 'preview') throw new Error(`only pr-<n> stacks are removed this way (got ${stack})`);
  const state = stateLocation(ctx.backendUrl);
  const present = exists(ctx, stack);
  if (present) {
    if (options.clearLock) clearLock(ctx, stack);
    const current = deployment(ctx, stack);
    if (current.secrets_providers) restoreSecretsConfig(ctx, stack, current);
    const destroyed = ctx.run('pulumi', ['destroy', '--yes', '--stack', stack]);
    if (!destroyed.ok) {
      // Pulumi prints the failing step's error with its progress on stdout, not stderr.
      const output = `${destroyed.stdout}\n${destroyed.stderr}`.trim();
      ctx.log(`pulumi destroy failed; the SQL drop below removes what the stack held:\n${output}`);
    }
  }
  // Always: covers a database from an earlier workflow, one leaked by an interrupted create, a failed destroy.
  dropPreviewDatabase(ctx, stack);
  if (present) must(ctx, ['stack', 'rm', stack, '--force', '--yes', '--remove-backups']);
  sweepState(ctx, stack, state);
}

/** The bucket and `.pulumi/` prefix of an S3 backend URL. */
function stateLocation(backendUrl: string): { bucket: string; prefix: string } {
  const url = new URL(backendUrl);
  if (url.protocol !== 's3:') throw new Error(`remove sweeps an s3:// backend only (got ${url.protocol}//)`);
  return { bucket: url.hostname, prefix: `${url.pathname.replace(/^\/|\/$/g, '')}/.pulumi/` };
}

/** Deletes any object Pulumi left for `stack` under the backend path (backups, history, locks), then checks. */
function sweepState(ctx: StackContext, stack: string, { bucket, prefix }: { bucket: string; prefix: string }): void {
  const own = new RegExp(`/${stack}(\\.json|/)`);
  const list = () => {
    const result = ctx.run('aws', ['s3', 'ls', `s3://${bucket}/${prefix}`, '--recursive']);
    // `aws s3 ls` exits 1 with no output when nothing is under the prefix; anything on stderr is a real failure.
    if (!result.ok && result.stderr.trim())
      throw new Error(`listing s3://${bucket}/${prefix} failed:\n${result.stderr}`);
    return result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/).slice(3).join(' '))
      .filter((key) => key && own.test(key));
  };
  for (const key of list()) {
    const result = ctx.run('aws', ['s3', 'rm', `s3://${bucket}/${key}`]);
    if (!result.ok) throw new Error(`deleting s3://${bucket}/${key} failed:\n${result.stderr}`);
  }
  const left = list();
  if (left.length > 0) throw new Error(`state objects left for ${stack}: ${left.join(', ')}`);
  ctx.log(`no state objects left for ${stack} under s3://${bucket}/${prefix}`);
}

/** Writes the stack config for `stack` from `values` as `module` lists it; values go through stdin, never argv. */
export function configure(
  run: Runner,
  stack: string,
  module: EntriesModule,
  values: ConfigValues,
  product: string,
  log: (line: string) => void
) {
  const { set, remove: unset } = configWrites(module, stack, values, product);
  for (const write of set) {
    // --plaintext says a long id is meant to be plain, so Pulumi does not stop on a value that looks like a secret.
    const args = ['config', 'set', '--stack', stack, write.secret ? '--secret' : '--plaintext', write.key];
    const result = run('pulumi', args, { input: write.value });
    if (!result.ok) throw new Error(`pulumi config set ${write.key} failed:\n${result.stderr}`);
  }
  for (const key of unset) run('pulumi', ['config', 'rm', '--stack', stack, key]);
  log(`configured ${stack}: ${set.map((w) => w.key).join(', ')}`);
}

/** The postgresql provider's error when two `CREATE DATABASE` copy template1 at once. */
const TEMPLATE1_COLLISION = /source database "template1" is being accessed by other users/;
const UP_ATTEMPTS = 3;

/**
 * `pulumi up`, its output streamed. A preview (run with `--refresh`) that collides with another
 * preview's `CREATE DATABASE` on template1 is tried again, up to three attempts, 10 s then 20 s apart; any other
 * failure, and every failure on staging, prod and shared, stops at once.
 */
export async function pulumiUp(
  stream: Streamer,
  stack: string,
  log: (line: string) => void,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const preview = stackKind(stack) === 'preview';
  const args = ['up', '--yes', ...(preview ? ['--refresh'] : []), '--stack', stack];
  for (let attempt = 1; ; attempt += 1) {
    const result = await stream('pulumi', args);
    if (result.ok) return;
    if (!preview || attempt >= UP_ATTEMPTS || !TEMPLATE1_COLLISION.test(result.output)) {
      throw new Error(`pulumi up -s ${stack} failed`);
    }
    log(
      `pulumi up -s ${stack} collided on template1 with another preview; trying again (${attempt + 1} of ${UP_ATTEMPTS})`
    );
    await sleep(attempt * 10_000);
  }
}

export interface StackOutput {
  key: string;
  /** The value as text: strings as they are, anything else as JSON. */
  value: string;
  /** Pulumi shows it as `[secret]` without `--show-secrets`. */
  secret: boolean;
}

/**
 * The stack's `name` output (an object), one entry per key. With `ifExists`, a stack that does not exist or has no
 * such output gives `undefined`; any other failure throws.
 */
export function stackOutputs(
  run: Runner,
  stack: string,
  name: string,
  options: { ifExists?: boolean } = {}
): StackOutput[] | undefined {
  const read = (showSecrets: boolean) =>
    run('pulumi', ['stack', 'output', name, '--json', ...(showSecrets ? ['--show-secrets'] : []), '--stack', stack]);
  const shown = read(false);
  if (!shown.ok) {
    const absent =
      shown.stderr.includes(`no stack named '${stack}' found`) ||
      shown.stderr.includes(`does not have output property '${name}'`);
    if (options.ifExists && absent) return undefined;
    throw new Error(`pulumi stack output ${name} -s ${stack} failed:\n${shown.stderr}`);
  }
  const revealed = read(true);
  if (!revealed.ok)
    throw new Error(`pulumi stack output ${name} --show-secrets -s ${stack} failed:\n${revealed.stderr}`);
  const masked = JSON.parse(shown.stdout) as unknown;
  const values = JSON.parse(revealed.stdout) as unknown;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`output ${name} of stack ${stack} is not an object`);
  }
  // A program in YAML shows the whole object as `[secret]`; one in TypeScript shows each secret key so.
  const isSecret = (key: string) =>
    masked === '[secret]' ||
    JSON.stringify((masked as Record<string, unknown>)[key] ?? '[secret]').includes('"[secret]"');
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
    secret: isSecret(key),
  }));
}
