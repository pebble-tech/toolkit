import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import pg from 'pg';
import { describe, expect, test } from 'vitest';

import { main } from './cli.js';

// `pebble-infra` run through its entry (`main`, what bin.ts calls) from a product's infra/ directory. Pulumi and aws
// are the fakes in ./fakes, found on PATH: real processes at the boundary, keeping a DIY backend as files on disk. The
// preview-stack tests also reach Postgres through the package's pg-database script, so they need DATABASE_URL (a local
// superuser); CI runs them against a service, and elsewhere they are skipped without it.

const FAKES = join(import.meta.dirname, 'fakes');
const BACKEND = 's3://acme-state/acme/preview?region=xx-test-1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres', 'db']);
const noPostgres = !process.env.DATABASE_URL && !process.env.CI;
const noPostgresReason = 'DATABASE_URL is unset: the preview-stack tests need a local Postgres (CI runs them)';

const ENTRIES = `
const ALL = ['shared', 'preview', 'staging', 'prod'];
const RUNTIME = ['staging', 'prod'];
export const entries = [
  { key: 'aws:region', env: 'AWS_REGION', secret: false, required: true, stacks: ALL },
  { key: 'pgAdminUrl', env: 'PG_ADMIN_URL', secret: true, required: true, stacks: ALL },
  { key: 'pgRuntimeUrl', env: 'DATABASE_RUNTIME_URL', secret: true, required: true, stacks: RUNTIME },
  { key: 'pgRuntimeRole', env: 'PG_RUNTIME_ROLE', secret: false, required: true, stacks: RUNTIME },
  { key: 'authSecret', env: 'AUTH_SECRET', secret: true, required: true, stacks: RUNTIME },
  { key: 'appBaseUrl', env: 'APP_BASE_URL', secret: false, required: false, stacks: RUNTIME },
];
export function derive(values) {
  if (!values.DATABASE_RUNTIME_URL) return {};
  return { PG_RUNTIME_ROLE: decodeURIComponent(new URL(values.DATABASE_RUNTIME_URL).username).split('.')[0] };
}
export const previewDatabase = true;
`;

/** A product whose previews have no database: a Worker and its Stage, no Postgres entry, no previewDatabase. */
const DATABASE_FREE = `
export const entries = [
  { key: 'aws:region', env: 'AWS_REGION', secret: false, required: true, stacks: ['shared', 'preview', 'staging', 'prod'] },
];
`;
const WORKER_PREVIEW = [
  'pulumi:pulumi:Stack',
  'pebbletech:index:Stage',
  'pebbletech:index:Worker',
  'cloudflare:index/workersScript:WorkersScript',
];

const SECRETS = {
  AWS_REGION: 'xx-test-1',
  PG_ADMIN_URL: 'postgresql://acme_admin:admin-pw-9f3c@db.example.test:5432/postgres',
  DATABASE_RUNTIME_URL: 'postgresql://acme_app.main:runtime-pw-4b1e@db.example.test:6432/acme_stg',
  AUTH_SECRET: 'auth-secret-71d2a8',
};

interface Call {
  tool: string;
  args: string[];
  env: Record<string, string>;
  stdin?: string;
}

/** A product's infra/ directory with its Pulumi.yaml and entries module, the fakes on PATH, and their backend. */
function product(name = 'acme') {
  const dir = mkdtempSync(join(tmpdir(), 'pebble-infra-cli-'));
  const bin = join(dir, 'bin');
  const infra = join(dir, 'infra');
  const s3 = join(dir, 's3');
  for (const path of [bin, infra, s3]) mkdirSync(path);
  for (const tool of ['pulumi', 'aws']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${join(FAKES, `${tool}.mjs`)}" "$@"\n`, {
      mode: 0o755,
    });
  }
  writeFileSync(join(infra, 'Pulumi.yaml'), `name: ${name}\nruntime: nodejs\nmain: dist/index.js\n`);
  writeFileSync(join(infra, 'entries.mjs'), ENTRIES);
  writeFileSync(join(infra, 'free.mjs'), DATABASE_FREE);
  const files = { log: join(dir, 'calls.jsonl'), plan: join(dir, 'plan.json'), output: join(dir, 'github-output') };
  writeFileSync(files.log, '');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    FAKE_S3: s3,
    FAKE_LOG: files.log,
    FAKE_PLAN: files.plan,
    PULUMI_BACKEND_URL: BACKEND,
    PULUMI_SECRETS_PROVIDER: 'awskms://alias/acme-preview?region=xx-test-1',
  };
  const stateRoot = join(s3, 'acme-state', 'acme', 'preview', '.pulumi');

  return {
    infra,
    files,
    /** `pebble-infra <argv>` with these extra variables; resolves to its exit code and what it wrote. */
    async run(argv: string[], extra: Record<string, string> = {}, onStdout: (text: string) => void = () => {}) {
      let stdout = '';
      let stderr = '';
      const sleeps: number[] = [];
      const code = await main(argv, {
        env: { ...env, ...extra },
        cwd: infra,
        stdout: (text) => {
          onStdout(text);
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      return { code, stdout, stderr, sleeps };
    },
    /** The `up` outcomes the fake pulumi plays, in order; then every `up` succeeds. */
    plan(steps: object[]) {
      writeFileSync(files.plan, JSON.stringify(steps));
    },
    calls(): Call[] {
      return readFileSync(files.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call);
    },
    commands(): string[] {
      return this.calls().map((call) => `${call.tool} ${call.args.join(' ')}`);
    },
    config(stack: string): Record<string, { value: string; secret: boolean }> {
      return JSON.parse(readFileSync(join(infra, `.fake-config-${stack}.json`), 'utf8'));
    },
    stateObjects(): string[] {
      return existsSync(stateRoot)
        ? readdirSync(stateRoot, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => relative(stateRoot, join(entry.parentPath, entry.name)))
            .sort()
        : [];
    },
    lock(stack: string) {
      mkdirSync(join(stateRoot, 'locks', 'acme', stack), { recursive: true });
      writeFileSync(join(stateRoot, 'locks', 'acme', stack, 'held-by-a-laptop.json'), '{}');
    },
  };
}

const matching = (commands: string[], pattern: RegExp) => commands.filter((command) => pattern.test(command));

describe('prepare', () => {
  test('creates a stack that does not exist, with the secrets provider from the environment', async () => {
    const p = product();
    const result = await p.run(['prepare', 'prod']);
    expect([result.code, result.stderr, p.commands()]).toEqual([
      0,
      'created stack prod\nstack prod: created\n',
      [
        'pulumi stack select prod',
        'pulumi stack init prod --secrets-provider awskms://alias/acme-preview?region=xx-test-1',
      ],
    ]);
  });

  test('without --clear-lock never runs pulumi cancel, and the lock stays', async () => {
    const p = product();
    await p.run(['up', 'prod', '--entries', 'entries.mjs'], SECRETS);
    p.lock('prod');
    const before = p.commands().length;
    const result = await p.run(['prepare', 'prod']);
    expect([
      result.code,
      matching(p.commands().slice(before), /cancel/),
      p.stateObjects().filter((o) => o.startsWith('locks/')),
    ]).toEqual([0, [], ['locks/acme/prod/held-by-a-laptop.json']]);
  });

  test('with --clear-lock cancels the lock a cancelled deploy left', async () => {
    const p = product();
    await p.run(['up', 'prod', '--entries', 'entries.mjs'], SECRETS);
    p.lock('prod');
    const result = await p.run(['prepare', 'prod', '--clear-lock']);
    expect([
      result.code,
      matching(p.commands(), /cancel/),
      p.stateObjects().filter((o) => o.startsWith('locks/')),
    ]).toEqual([0, ['pulumi cancel --yes --stack prod'], []]);
  });

  test('--preview-only on a stack that does not exist refuses, and runs no init, cancel or rm', async () => {
    const p = product();
    const result = await p.run(['prepare', 'prod', '--preview-only']);
    expect([
      result.code,
      result.stderr,
      matching(p.commands(), /stack init|cancel|stack rm/),
      p.stateObjects(),
    ]).toEqual([
      1,
      'stack prod does not exist; a preview does not create it (the deploying run does: pebble-infra prepare prod)\n',
      [],
      [],
    ]);
  });

  test('--preview-only on a locked, deployed stack selects it and leaves the lock', async () => {
    const p = product();
    await p.run(['up', 'prod', '--entries', 'entries.mjs'], SECRETS);
    p.lock('prod');
    const before = p.commands().length;
    const result = await p.run(['prepare', 'prod', '--preview-only']);
    expect([result.code, p.commands().slice(before)]).toEqual([
      0,
      ['pulumi stack select prod', 'pulumi stack export --stack prod'],
    ]);
  });

  test('--preview-only with --clear-lock is a usage error', async () => {
    const p = product();
    const result = await p.run(['prepare', 'prod', '--preview-only', '--clear-lock']);
    expect([result.code, result.stderr.split('\n')[0], p.commands()]).toEqual([
      2,
      '--preview-only never clears a lock',
      [],
    ]);
  });

  test('a product id the toolkit refuses stops before any pulumi call', async () => {
    const p = product('pebbleshop');
    const result = await p.run(['prepare', 'prod']);
    expect([result.code, result.stderr, p.commands()]).toEqual([
      1,
      'product id "pebbleshop" starts with "pebble", which is reserved for shared infrastructure\n',
      [],
    ]);
  });
});

describe('configure', () => {
  test('writes every value through stdin, secrets as secrets, the derived role, and removes a blank optional', async () => {
    const p = product();
    await p.run(['prepare', 'staging']);
    const result = await p.run(['configure', 'staging', '--entries', 'entries.mjs'], { ...SECRETS, APP_BASE_URL: ' ' });
    expect([result.code, p.config('staging'), matching(p.commands(), /config/)]).toEqual([
      0,
      {
        'aws:region': { value: 'xx-test-1', secret: false },
        'acme:pgAdminUrl': { value: SECRETS.PG_ADMIN_URL, secret: true },
        'acme:pgRuntimeUrl': { value: SECRETS.DATABASE_RUNTIME_URL, secret: true },
        'acme:pgRuntimeRole': { value: 'acme_app', secret: false },
        'acme:authSecret': { value: SECRETS.AUTH_SECRET, secret: true },
      },
      [
        'pulumi config set --stack staging --plaintext aws:region',
        'pulumi config set --stack staging --secret acme:pgAdminUrl',
        'pulumi config set --stack staging --secret acme:pgRuntimeUrl',
        'pulumi config set --stack staging --plaintext acme:pgRuntimeRole',
        'pulumi config set --stack staging --secret acme:authSecret',
        'pulumi config rm --stack staging acme:appBaseUrl',
      ],
    ]);
  });

  test('a missing required entry is refused by its variable name, before any config write', async () => {
    const p = product();
    const rest = Object.fromEntries(
      Object.entries(SECRETS).filter(([key]) => !['AUTH_SECRET', 'AWS_REGION'].includes(key))
    );
    const result = await p.run(['configure', 'staging', '--entries', 'entries.mjs'], rest);
    expect([result.code, result.stderr, matching(p.commands(), /config/)]).toEqual([
      1,
      'stack staging needs AWS_REGION, AUTH_SECRET\n',
      [],
    ]);
  });

  test('--product names the namespace when Pulumi.yaml is not the product id', async () => {
    const p = product('acme-infra');
    await p.run(['prepare', 'shared', '--product', 'shop']);
    const result = await p.run(['configure', 'shared', '--entries', 'entries.mjs', '--product', 'shop'], SECRETS);
    expect([result.code, Object.keys(p.config('shared'))]).toEqual([0, ['aws:region', 'shop:pgAdminUrl']]);
  });

  test('an entries module without an entries array is refused by path', async () => {
    const p = product();
    writeFileSync(join(p.infra, 'broken.mjs'), 'export const entry = [];\n');
    const result = await p.run(['configure', 'staging', '--entries', 'broken.mjs'], SECRETS);
    expect([result.code, result.stderr]).toEqual([1, 'broken.mjs: exports no `entries` array\n']);
  });
});

describe('PEBBLE_INFRA_VALUES', () => {
  test('is read first, reaches no child process, and its secrets reach no output', async () => {
    const p = product();
    const values = JSON.stringify(SECRETS);
    // The environment's stale AUTH_SECRET loses to the one in PEBBLE_INFRA_VALUES.
    const result = await p.run(['up', 'staging', '--entries', 'entries.mjs'], {
      PEBBLE_INFRA_VALUES: values,
      AUTH_SECRET: 'stale-env-value',
    });
    const outputs = `${result.stdout}${result.stderr}`;
    const secrets = ['admin-pw-9f3c', 'runtime-pw-4b1e', SECRETS.AUTH_SECRET];
    expect([
      result.code,
      p.config('staging')['acme:authSecret'],
      [...new Set(p.calls().map((call) => `${call.tool} ${call.args[0]}`))],
      p.calls().filter((call) => 'PEBBLE_INFRA_VALUES' in call.env).length,
      secrets.filter((secret) => outputs.includes(secret)),
    ]).toEqual([
      0,
      { value: SECRETS.AUTH_SECRET, secret: true },
      ['pulumi stack', 'pulumi config', 'pulumi up'],
      0,
      [],
    ]);
  });

  test.each([
    ['not JSON', '{"AUTH_SECRET": "auth-secret-71d2a8"', 'PEBBLE_INFRA_VALUES is not valid JSON'],
    ['an array', '["auth-secret-71d2a8"]', 'PEBBLE_INFRA_VALUES must be a JSON object of variable names to values'],
    [
      'a non-string value',
      '{"AUTH_SECRET": ["auth-secret-71d2a8"]}',
      'PEBBLE_INFRA_VALUES values must be strings: AUTH_SECRET',
    ],
  ])('%s is refused without repeating the value', async (_, value, message) => {
    const p = product();
    const result = await p.run(['configure', 'staging', '--entries', 'entries.mjs'], { PEBBLE_INFRA_VALUES: value });
    expect([result.code, result.stderr, result.stdout, p.commands()]).toEqual([1, `${message}\n`, '', []]);
  });
});

describe('up', () => {
  test('prepares, configures, streams pulumi up and writes the outputs, each secret masked before the write', async () => {
    const p = product();
    const databaseUrl = 'postgresql://acme_stg_owner:owner-pw-5e0a@db/acme_stg';
    const certificate = '-----BEGIN-----\ncert-line-0c9d\n-----END-----';
    p.plan([
      {
        result: 'ok',
        outputs: { databaseUrl: { secret: databaseUrl }, certificate: { secret: certificate }, projectId: 'prj_1' },
      },
    ]);
    const result = await p.run(['up', 'staging', '--entries', 'entries.mjs'], {
      ...SECRETS,
      GITHUB_OUTPUT: p.files.output,
    });
    const written = readFileSync(p.files.output, 'utf8');
    const delimiter = /^certificate<<(ghadelimiter_[0-9a-f-]+)$/m.exec(written)?.[1];
    expect([
      result.code,
      matching(p.commands(), /^pulumi (stack init|up|stack output)/),
      result.stdout.includes('Updating (staging)'),
      result.stdout.split('\n').filter((line) => line.startsWith('::add-mask::')),
      written,
    ]).toEqual([
      0,
      [
        'pulumi stack init staging --secrets-provider awskms://alias/acme-preview?region=xx-test-1',
        'pulumi up --yes --stack staging',
        'pulumi stack output outputs --json --stack staging',
        'pulumi stack output outputs --json --show-secrets --stack staging',
      ],
      true,
      [
        `::add-mask::${databaseUrl}`,
        '::add-mask::-----BEGIN-----%0Acert-line-0c9d%0A-----END-----',
        '::add-mask::-----BEGIN-----',
        '::add-mask::cert-line-0c9d',
        '::add-mask::-----END-----',
      ],
      `database_url=${databaseUrl}\ncertificate<<${delimiter}\n${certificate}\n${delimiter}\nproject_id=prj_1\n`,
    ]);
  });

  test('the masks are printed while $GITHUB_OUTPUT still holds no secret', async () => {
    const p = product();
    p.plan([{ result: 'ok', outputs: { databaseUrl: { secret: 'postgresql://u:owner-pw-5e0a@db/acme_stg' } } }]);
    // What $GITHUB_OUTPUT holds at the moment each mask is printed.
    const seen: string[] = [];
    const { code } = await p.run(
      ['up', 'staging', '--entries', 'entries.mjs'],
      { ...SECRETS, GITHUB_OUTPUT: p.files.output },
      (text) => {
        if (text.startsWith('::add-mask::'))
          seen.push(existsSync(p.files.output) ? readFileSync(p.files.output, 'utf8') : '');
      }
    );
    expect([code, seen, readFileSync(p.files.output, 'utf8')]).toEqual([
      0,
      [''],
      'database_url=postgresql://u:owner-pw-5e0a@db/acme_stg\n',
    ]);
  });

  test('a program that shows its whole outputs object as [secret] has every value masked', async () => {
    const p = product();
    p.plan([
      { result: 'ok', wholeSecret: true, outputs: { databaseUrl: { secret: 'db-url-77' }, projectId: 'prj_1' } },
    ]);
    const result = await p.run(['up', 'staging', '--entries', 'entries.mjs'], {
      ...SECRETS,
      GITHUB_OUTPUT: p.files.output,
    });
    expect([result.code, result.stdout.split('\n').filter((l) => l.startsWith('::add-mask::'))]).toEqual([
      0,
      ['::add-mask::db-url-77', '::add-mask::prj_1'],
    ]);
  });

  test('a mask escapes %, CR and LF as @actions/core does, so it matches the value written', async () => {
    const p = product();
    const secret = 'p%0Aq\rr%25s';
    p.plan([{ result: 'ok', outputs: { token: { secret } } }]);
    const result = await p.run(['up', 'staging', '--entries', 'entries.mjs'], {
      ...SECRETS,
      GITHUB_OUTPUT: p.files.output,
    });
    const written = readFileSync(p.files.output, 'utf8');
    const delimiter = /^token<<(ghadelimiter_[0-9a-f-]+)$/m.exec(written)?.[1];
    // What `core.setSecret('p%0Aq\rr%25s')` (@actions/core 1.11.1) prints.
    expect([result.code, result.stdout.split('\n').filter((l) => l.startsWith('::add-mask::')), written]).toEqual([
      0,
      ['::add-mask::p%250Aq%0Dr%2525s'],
      `token<<${delimiter}\n${secret}\n${delimiter}\n`,
    ]);
  });

  test.each([
    ['a template1 collision', { result: 'template1' }],
    ['any other failure', { result: 'fail' }],
  ])('on staging, %s fails at once with no retry', async (_, step) => {
    const p = product();
    p.plan([step]);
    const result = await p.run(['up', 'staging', '--entries', 'entries.mjs'], SECRETS);
    expect([result.code, matching(p.commands(), /^pulumi up/).length, result.sleeps]).toEqual([1, 1, []]);
  });
});

describe('preview', () => {
  test('prepares without touching the lock, configures, and writes the diff to the step summary', async () => {
    const p = product();
    await p.run(['up', 'prod', '--entries', 'entries.mjs'], SECRETS);
    p.lock('prod');
    const before = p.commands().length;
    const summary = join(p.infra, 'summary.md');
    const result = await p.run(['preview', 'prod', '--entries', 'entries.mjs', '--summary'], {
      ...SECRETS,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_SHA: 'abc123',
    });
    expect([
      result.code,
      matching(p.commands().slice(before), /cancel|stack init|stack rm|^pulumi up/),
      matching(p.commands().slice(before), /^pulumi preview/),
      readFileSync(summary, 'utf8'),
    ]).toEqual([
      0,
      [],
      ['pulumi preview --diff --color never --stack prod'],
      '### pulumi preview -s prod (abc123)\n```diff\nPreviewing update (prod)\n~ aws:lambda/function:Function api update [diff: ~code]\n```\n',
    ]);
  });

  test('a stack that does not exist is refused before any config is written', async () => {
    const p = product();
    const result = await p.run(['preview', 'prod', '--entries', 'entries.mjs'], SECRETS);
    expect([result.code, matching(p.commands(), /config|stack init|preview/)]).toEqual([1, []]);
  });
});

describe('outputs', () => {
  test('--if-exists on a stack that does not exist exits 0 and writes nothing', async () => {
    const p = product();
    const result = await p.run(['outputs', 'prod', '--github-output', '--if-exists'], {
      GITHUB_OUTPUT: p.files.output,
    });
    expect([result.code, result.stdout, existsSync(p.files.output)]).toEqual([0, '', false]);
  });

  test('--if-exists on a stack never updated (no outputs yet) exits 0 and writes nothing', async () => {
    const p = product();
    await p.run(['prepare', 'prod']);
    const result = await p.run(['outputs', 'prod', '--github-output', '--if-exists'], {
      GITHUB_OUTPUT: p.files.output,
    });
    expect([result.code, result.stdout, existsSync(p.files.output)]).toEqual([0, '', false]);
  });

  test('without --if-exists, a stack that does not exist fails', async () => {
    const p = product();
    const result = await p.run(['outputs', 'prod']);
    expect([result.code, result.stderr]).toEqual([
      1,
      "pulumi stack output outputs -s prod failed:\nerror: no stack named 'prod' found\n\n",
    ]);
  });

  test('prints the outputs with secrets hidden, or writes them masked with --github-output', async () => {
    const p = product();
    p.plan([{ result: 'ok', outputs: { databaseUrl: { secret: 'db-url-77' }, projectId: 'prj_1' } }]);
    await p.run(['up', 'prod', '--entries', 'entries.mjs'], SECRETS);
    const shown = await p.run(['outputs', 'prod']);
    const written = await p.run(['outputs', 'prod', '--github-output'], { GITHUB_OUTPUT: p.files.output });
    expect([shown.stdout, written.stdout, readFileSync(p.files.output, 'utf8')]).toEqual([
      '{\n  "databaseUrl": "[secret]",\n  "projectId": "prj_1"\n}\n',
      '::add-mask::db-url-77\n',
      'database_url=db-url-77\nproject_id=prj_1\n',
    ]);
  });

  test('--outputs names another export', async () => {
    const p = product();
    const result = await p.run(['outputs', 'prod', '--outputs', 'web', '--if-exists']);
    expect([result.code, matching(p.commands(), /stack output/)]).toEqual([
      0,
      ['pulumi stack output web --json --stack prod'],
    ]);
  });
});

describe('usage', () => {
  test.each([
    [['deploy', 'prod'], 'unknown command deploy'],
    [['up', 'prod'], 'up needs --entries <module>'],
    [['outputs', 'prod', '--clear-lock'], 'outputs takes no --clear-lock'],
    [['prepare'], 'prepare takes a stack'],
    [
      ['prepare', 'pr-7'],
      'prepare pr-7 needs --entries <module>: its previewDatabase says whether the preview has a database',
    ],
    [
      ['remove', 'pr-7', '--clear-lock'],
      'remove pr-7 needs --entries <module>: its previewDatabase says whether the preview has a database',
    ],
  ])('%j exits 2: %s', async (argv, message) => {
    const p = product();
    const result = await p.run(argv);
    expect([result.code, result.stderr.split('\n')[0], p.commands()]).toEqual([2, message, []]);
  });

  test('remove refuses a stack that is not a preview', async () => {
    const p = product();
    const result = await p.run(['remove', 'staging', '--clear-lock']);
    expect([result.code, result.stderr, p.commands()]).toEqual([
      1,
      'only pr-<n> stacks are removed this way (got staging)\n',
      [],
    ]);
  });
});

describe('a product whose previews have no database', () => {
  test('up and remove a preview with no PG_ADMIN_URL, never reaching Postgres', async () => {
    const p = product();
    p.plan([{ result: 'ok', resources: WORKER_PREVIEW }]);
    const deployed = await p.run(['up', 'pr-12345', '--entries', 'free.mjs'], { AWS_REGION: 'xx-test-1' });
    const removed = await p.run(['remove', 'pr-12345', '--entries', 'free.mjs', '--clear-lock']);
    expect([deployed.code, deployed.stderr.split('\n')[0], removed.code, p.stateObjects()]).toEqual([
      0,
      'created stack pr-12345',
      0,
      [],
    ]);
  });

  test('a cancelled update holding only its Stage is reset without Postgres', async () => {
    const p = product();
    p.plan([{ result: 'interrupt', resources: ['pulumi:pulumi:Stack'], pending: ['pebbletech:index:Stage'] }]);
    await p.run(['up', 'pr-12346', '--entries', 'free.mjs'], { AWS_REGION: 'xx-test-1' });
    const result = await p.run(['prepare', 'pr-12346', '--entries', 'free.mjs', '--clear-lock']);
    expect([result.code, result.stderr]).toEqual([
      0,
      'reset stack pr-12346 (1 pending operations, 1 resources)\nstack pr-12346: reset\n',
    ]);
  });

  test('remove keeps the state and fails when destroy leaves a Worker behind', async () => {
    const p = product();
    p.plan([
      { result: 'ok', resources: WORKER_PREVIEW },
      { command: 'destroy', result: 'fail', message: 'cloudflare deletion refused: 403' },
    ]);
    await p.run(['up', 'pr-12347', '--entries', 'free.mjs'], { AWS_REGION: 'xx-test-1' });
    const before = p.commands().length;
    const result = await p.run(['remove', 'pr-12347', '--entries', 'free.mjs', '--clear-lock']);
    expect([
      result.code,
      result.stderr.split('\n')[0],
      matching(p.commands().slice(before), /stack rm|aws s3 rm/),
      p.stateObjects().filter((o) => o.startsWith('stacks/')),
    ]).toEqual([
      1,
      'pulumi destroy -s pr-12347 failed and the stack still holds cloudflare:index/workersScript:WorkersScript, pebbletech:index:Worker, beyond its Stage; its state is kept so another remove can finish once the cause is fixed:',
      [],
      ['stacks/acme/pr-12347.json'],
    ]);
  });
});

// ---- Preview stacks: the database closure reaches Postgres through the pg-database script. ----

function adminUrl(): string {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is unset: CI must run these tests against Postgres');
  const url = new URL(process.env.DATABASE_URL);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`these tests create databases; DATABASE_URL must be a local Postgres (got ${url.hostname})`);
  }
  url.pathname = '/postgres';
  return url.toString();
}

async function sql(query: string): Promise<unknown[]> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return (await client.query(query)).rows;
  } finally {
    await client.end();
  }
}

const databaseExists = async (name: string) =>
  (await sql(`select 1 from pg_database where datname = '${name}'`)).length === 1;

describe('preview stacks (Postgres)', () => {
  test('prepare drops a database an earlier workflow left, then creates the stack', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    await sql('drop database if exists acme_pr_81001 with (force)');
    await sql('create database acme_pr_81001');
    const result = await p.run(['prepare', 'pr-81001', '--entries', 'entries.mjs'], { PG_ADMIN_URL: adminUrl() });
    expect([result.code, result.stderr, await databaseExists('acme_pr_81001')]).toEqual([
      0,
      'dropped acme_pr_81001 and its role if they existed\ncreated stack pr-81001\nstack pr-81001: created\n',
      false,
    ]);
  });

  test('PG_ADMIN_URL from PEBBLE_INFRA_VALUES reaches the database drop', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    await sql('drop database if exists acme_pr_81002 with (force)');
    await sql('create database acme_pr_81002');
    const result = await p.run(['prepare', 'pr-81002', '--entries', 'entries.mjs'], {
      PEBBLE_INFRA_VALUES: JSON.stringify({ PG_ADMIN_URL: adminUrl() }),
    });
    expect([result.code, await databaseExists('acme_pr_81002')]).toEqual([0, false]);
  });

  test('up retries a template1 collision twice, 10 s then 20 s apart, then succeeds', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    p.plan([{ result: 'template1' }, { result: 'template1' }, { result: 'ok' }]);
    const result = await p.run(['up', 'pr-81003', '--entries', 'entries.mjs'], {
      ...SECRETS,
      PG_ADMIN_URL: adminUrl(),
    });
    expect([result.code, matching(p.commands(), /^pulumi up/), result.sleeps]).toEqual([
      0,
      Array.from({ length: 3 }, () => 'pulumi up --yes --refresh --stack pr-81003'),
      [10_000, 20_000],
    ]);
  });

  test('up stops after the third template1 collision', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    p.plan([{ result: 'template1' }, { result: 'template1' }, { result: 'template1' }, { result: 'ok' }]);
    const result = await p.run(['up', 'pr-81004', '--entries', 'entries.mjs'], {
      ...SECRETS,
      PG_ADMIN_URL: adminUrl(),
    });
    expect([result.code, matching(p.commands(), /^pulumi up/).length, result.sleeps]).toEqual([1, 3, [10_000, 20_000]]);
  });

  test('up surfaces any other preview failure at once', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    p.plan([{ result: 'fail', message: 'provider vercel: 403 Forbidden' }]);
    const result = await p.run(['up', 'pr-81005', '--entries', 'entries.mjs'], {
      ...SECRETS,
      PG_ADMIN_URL: adminUrl(),
    });
    expect([
      result.code,
      matching(p.commands(), /^pulumi up/).length,
      result.sleeps,
      result.stderr.split('\n').at(-2),
    ]).toEqual([1, 1, [], 'pulumi up -s pr-81005 failed']);
  });

  test('a cancelled update that left only the database closure is reset', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    p.plan([
      {
        result: 'interrupt',
        resources: ['pulumi:pulumi:Stack', 'pebbletech:index:Stage'],
        pending: ['postgresql:index/role:Role'],
      },
    ]);
    await p.run(['up', 'pr-81006', '--entries', 'entries.mjs'], { ...SECRETS, PG_ADMIN_URL: adminUrl() });
    const result = await p.run(['prepare', 'pr-81006', '--entries', 'entries.mjs', '--clear-lock'], {
      PG_ADMIN_URL: adminUrl(),
    });
    expect([result.code, result.stderr.split('\n').at(-2)]).toEqual([0, 'stack pr-81006: reset']);
  });

  test('the preview reset refuses a state holding a Worker, names its types, and removes nothing', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    p.plan([
      {
        result: 'interrupt',
        resources: ['pulumi:pulumi:Stack', 'pebbletech:index:Stage', 'pebbletech:index:Worker'],
        pending: ['cloudflare:index/workersScript:WorkersScript'],
      },
    ]);
    await p.run(['up', 'pr-81007', '--entries', 'entries.mjs'], { ...SECRETS, PG_ADMIN_URL: adminUrl() });
    const before = p.commands().length;
    const result = await p.run(['prepare', 'pr-81007', '--entries', 'entries.mjs', '--clear-lock'], {
      PG_ADMIN_URL: adminUrl(),
    });
    expect([
      result.code,
      result.stderr,
      matching(p.commands().slice(before), /stack rm|stack init/),
      p.stateObjects().filter((o) => o.startsWith('stacks/')),
    ]).toEqual([
      1,
      'stack pr-81007 holds cloudflare:index/workersScript:WorkersScript, pebbletech:index:Worker, beyond its database; a reset would leave them running. Run `pulumi refresh -s pr-81007` and check each pending operation, or remove the preview (pebble-infra remove pr-81007)\n',
      [],
      ['stacks/acme/pr-81007.json'],
    ]);
  });

  test('remove --clear-lock destroys a locked preview, drops its database and sweeps every state object', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    await p.run(['up', 'pr-81008', '--entries', 'entries.mjs'], { ...SECRETS, PG_ADMIN_URL: adminUrl() });
    p.lock('pr-81008');
    await sql('drop database if exists acme_pr_81008 with (force)');
    await sql('create database acme_pr_81008');
    const before = p.stateObjects();
    const result = await p.run(['remove', 'pr-81008', '--entries', 'entries.mjs', '--clear-lock'], {
      PG_ADMIN_URL: adminUrl(),
    });
    expect([
      before.length > 2,
      result.code,
      p.stateObjects(),
      await databaseExists('acme_pr_81008'),
      matching(p.commands(), /^aws s3 rm/).length > 0,
    ]).toEqual([true, 0, [], false, true]);
  });

  test('remove without --clear-lock leaves a locked stack and fails', async (ctx) => {
    ctx.skip(noPostgres, noPostgresReason);
    const p = product();
    await p.run(['up', 'pr-81009', '--entries', 'entries.mjs'], { ...SECRETS, PG_ADMIN_URL: adminUrl() });
    p.lock('pr-81009');
    const result = await p.run(['remove', 'pr-81009', '--entries', 'entries.mjs'], { PG_ADMIN_URL: adminUrl() });
    expect([
      result.code,
      matching(p.commands(), /cancel/),
      p.stateObjects().includes('stacks/acme/pr-81009.json'),
    ]).toEqual([1, [], true]);
  });
});
