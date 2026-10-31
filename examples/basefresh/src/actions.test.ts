import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// The toolkit's setup and pulumi actions run against this example as a product's workflow runs them: the script that
// resolves an installed version, and the pulumi action's one step (run.sh), with the variables GitHub would set. pnpm
// and pulumi are fakes on PATH that record their arguments; the actions' own code runs for real.

const BASEFRESH = join(import.meta.dirname, '..');
const ACTIONS = join(BASEFRESH, '../../.github/actions');
const INSTALLED = join(ACTIONS, 'installed.mjs');
const RUN = join(ACTIONS, 'pulumi/run.sh');
/** The version the action checkout is from: the toolkit's own @pebbletech/infra. */
const OWN = JSON.parse(readFileSync(join(ACTIONS, '../../packages/infra/package.json'), 'utf8')).version as string;

/** A directory with `<name>@<version>` installed under node_modules, as pnpm leaves it. */
function installedFor(packages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pebble-actions-'));
  for (const [name, version] of Object.entries(packages)) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  return dir;
}

const installed = (dir: string, name: string) =>
  spawnSync(process.execPath, [INSTALLED, dir, name], { encoding: 'utf8' });

describe('the Pulumi CLI version setup installs', () => {
  test('is the @pulumi/pulumi this example installed', () => {
    const program = createRequire(join(BASEFRESH, 'package.json'))('@pulumi/pulumi/package.json').version;
    expect([installed(BASEFRESH, '@pulumi/pulumi').stdout, program]).toEqual([
      `${program}\n`,
      expect.stringMatching(/^\d+\.\d+\.\d+$/),
    ]);
  });

  test('is read from the nearest node_modules up the tree, not fixed', () => {
    const root = installedFor({ '@pulumi/pulumi': '3.199.4' });
    const infra = join(root, 'infra');
    mkdirSync(infra);
    expect(installed(infra, '@pulumi/pulumi')).toMatchObject({ status: 0, stdout: '3.199.4\n' });
  });

  // infra/ a symlink to packages/program, with one SDK in the root's node_modules and another in packages/: Node runs
  // the program from its real path, so it loads the one under packages/.
  test('follows a symlinked infra directory to where Node resolves the program from', () => {
    const root = installedFor({ '@pulumi/pulumi': '3.199.4' });
    const packages = join(root, 'packages');
    const sdk = join(packages, 'node_modules/@pulumi/pulumi');
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ version: '3.250.1' }));
    const program = join(packages, 'program');
    mkdirSync(program);
    writeFileSync(join(program, 'index.cjs'), "console.log(require('@pulumi/pulumi/package.json').version)");
    symlinkSync(program, join(root, 'infra'), 'dir');
    const runs = (dir: string) => spawnSync(process.execPath, [join(dir, 'index.cjs')], { encoding: 'utf8' }).stdout;
    expect([program, join(root, 'infra')].map((dir) => [installed(dir, '@pulumi/pulumi').stdout, runs(dir)])).toEqual([
      ['3.250.1\n', '3.250.1\n'],
      ['3.250.1\n', '3.250.1\n'],
    ]);
  });

  test('refuses, naming the package and the infra input, when @pulumi/pulumi is not installed', () => {
    const empty = installedFor({});
    expect(installed(empty, '@pulumi/pulumi')).toMatchObject({
      status: 1,
      stdout: '',
      stderr: expect.stringContaining(`@pulumi/pulumi is not installed for ${empty}`),
    });
    expect(installed(empty, '@pulumi/pulumi').stderr).toContain("set the action's infra input");
  });

  test('refuses a version that is not x.y.z, which would reach the installer and the cache key', () => {
    const odd = installedFor({ '@pulumi/pulumi': 'latest; curl evil' });
    expect(installed(odd, '@pulumi/pulumi')).toMatchObject({ status: 1, stdout: '' });
  });
});

/** Runs the pulumi action's step with its inputs as GitHub passes them, and the fakes on PATH. */
function step(inputs: Partial<Record<'COMMAND' | 'STACK' | 'ENTRIES' | 'CLEAR_LOCK' | 'SUMMARY' | 'INFRA', string>>) {
  const dir = mkdtempSync(join(tmpdir(), 'pebble-pulumi-action-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.jsonl');
  mkdirSync(bin);
  for (const tool of ['pnpm', 'pulumi']) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec "${process.execPath}" -e 'require("fs").appendFileSync(process.env.CALLS, JSON.stringify(["${tool}", ...process.argv.slice(1)]) + "\\n")' -- "$@"\n`,
      { mode: 0o755 }
    );
  }
  const result = spawnSync('bash', [RUN], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: log,
      COMMAND: 'up',
      STACK: 'prod',
      ENTRIES: 'dist/entries.js',
      CLEAR_LOCK: 'false',
      SUMMARY: 'false',
      INFRA: BASEFRESH,
      ...inputs,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];
  return { status: result.status, stderr: result.stderr, calls, dir };
}

const pnpmCall = (infra: string, ...args: string[]) => ['pnpm', '--dir', infra, 'exec', 'pebble-infra', ...args];

describe('the pulumi action', () => {
  test('runs the installed pebble-infra with each input as one argument', () => {
    expect(step({ CLEAR_LOCK: 'true' })).toMatchObject({
      status: 0,
      calls: [pnpmCall(BASEFRESH, 'up', 'prod', '--entries=dist/entries.js', '--clear-lock')],
    });
  });

  test('logs in first when PULUMI_BACKEND_URL is set, as a run: step would', () => {
    const backend = 'file:///tmp/state';
    const dir = mkdtempSync(join(tmpdir(), 'pebble-pulumi-login-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['pnpm', 'pulumi'])
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${join(dir, 'calls')}"\n`, { mode: 0o755 });
    const result = spawnSync('bash', [RUN], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        PULUMI_BACKEND_URL: backend,
        COMMAND: 'preview',
        STACK: 'prod',
        ENTRIES: 'dist/entries.js',
        CLEAR_LOCK: 'false',
        SUMMARY: 'true',
        INFRA: BASEFRESH,
      },
    });
    expect([result.status, readFileSync(join(dir, 'calls'), 'utf8')]).toEqual([
      0,
      `pulumi login ${backend}\npnpm --dir ${BASEFRESH} exec pebble-infra preview prod --entries=dist/entries.js --summary\n`,
    ]);
  });

  test('never runs an input as shell', () => {
    const run = step({ STACK: 'pr-1"; touch pwned; "', ENTRIES: '$(touch pwned) dist/e.js' });
    expect([run.status, run.calls, existsSync(join(run.dir, 'pwned'))]).toEqual([
      0,
      [pnpmCall(BASEFRESH, 'up', 'pr-1"; touch pwned; "', '--entries=$(touch pwned) dist/e.js')],
      false,
    ]);
  });

  test.each([
    ['a command other than up, preview or remove', { COMMAND: 'destroy' }, 'command is up, preview or remove'],
    ['a stack that would read as a flag', { STACK: '--product=other' }, 'stack is a stack name'],
    ['a flag that is not true or false', { CLEAR_LOCK: 'yes' }, 'clear-lock is true or false'],
  ])('refuses %s before running anything', (_name, inputs, message) => {
    expect(step(inputs)).toMatchObject({ status: 2, calls: [], stderr: expect.stringContaining(message) });
  });

  describe('against the installed @pebbletech/infra', () => {
    const [major, minor, patch] = OWN.split(/[.-]/).map(Number) as [number, number, number];

    test('runs when its major.minor is the action’s, whatever the patch', () => {
      const infra = installedFor({ '@pebbletech/infra': `${major}.${minor}.${patch + 7}` });
      expect(step({ INFRA: infra })).toMatchObject({
        status: 0,
        calls: [pnpmCall(infra, 'up', 'prod', '--entries=dist/entries.js')],
      });
    });

    test.each([`${major}.${minor + 1}.0`, `${major + 1}.${minor}.${patch}`])(
      'refuses %s before running anything',
      (version) => {
        const infra = installedFor({ '@pebbletech/infra': version });
        expect(step({ INFRA: infra })).toMatchObject({
          status: 1,
          calls: [],
          stderr: expect.stringContaining(
            `@pebbletech/infra ${version} is installed for ${infra}, but this action is from @pebbletech/infra ${OWN}`
          ),
        });
      }
    );

    test('refuses when the product has not installed it', () => {
      const infra = installedFor({});
      expect(step({ INFRA: infra })).toMatchObject({
        status: 1,
        calls: [],
        stderr: expect.stringContaining('@pebbletech/infra is not installed'),
      });
    });
  });
});
