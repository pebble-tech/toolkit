import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { main } from './cli.js';
import { prepare, processRunner, remove, type Runner, type StackContext } from './stack.js';

// The preview jobs' SQL against a real Postgres, with admins of the kind PlanetScale gives: not a superuser, CREATEROLE
// and CREATEDB. Pulumi is faked as the external CLI it is; the package's pg-database script runs for real. CI runs it
// against a Postgres service (verify.yml); without DATABASE_URL it fails in CI and is skipped elsewhere.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres', 'db']);
const STACK = 'pr-90417';
const DATABASE = 'acme_pr_90417';
const ADMIN = `acme_infra_test_admin_${randomBytes(4).toString('hex')}`;
const ADMIN_PASSWORD = randomBytes(12).toString('hex');
/** The admin a rotated PG_ADMIN_URL replaced (on PlanetScale, an API admin whose password was rotated). */
const OLD_ADMIN = `${ADMIN}_old`;
const OWNED = 'acme_pr_90418';
const OWNER = `${ADMIN}_owner`;
const ROTATED_STACK = 'pr-90419';
const ROTATED = 'acme_pr_90419';
const skipped = !process.env.DATABASE_URL && !process.env.CI;
const skipReason = 'DATABASE_URL is unset: this test needs a local Postgres (CI runs it against a service)';

function clusterUrl(user?: { name: string; password: string }): string {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is unset: CI must run this test against Postgres');
  const url = new URL(process.env.DATABASE_URL);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `this test creates roles; DATABASE_URL must be a local Postgres (got ${url.hostname || 'nothing'})`
    );
  }
  url.pathname = '/postgres';
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

async function sql<T extends pg.QueryResultRow>(url: string, query: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(query, values)).rows;
  } finally {
    await client.end();
  }
}

const superuser = () => clusterUrl();
const admin = () => clusterUrl({ name: ADMIN, password: ADMIN_PASSWORD });
const oldAdmin = () => clusterUrl({ name: OLD_ADMIN, password: ADMIN_PASSWORD });

async function cleanUp(): Promise<void> {
  for (const database of [DATABASE, OWNED, ROTATED]) {
    await sql(superuser(), `drop database if exists ${database} with (force)`);
  }
  for (const role of [DATABASE, ROTATED, OWNER, ADMIN, OLD_ADMIN])
    await sql(superuser(), `drop role if exists ${role}`);
}

async function exists(name: string) {
  return (
    await sql<{ databases: number; roles: number }>(
      superuser(),
      `select (select count(*)::int from pg_database where datname = $1) as databases,
              (select count(*)::int from pg_roles where rolname = $1) as roles`,
      [name]
    )
  )[0];
}

/** The Pulumi and aws commands, faked; every other command is recorded and `node` runs for real as ADMIN. */
function context(destroyOutput = '', resources = 0) {
  const node = processRunner({ env: { ...process.env, PG_ADMIN_URL: admin() } });
  const deployment = {
    resources: Array.from({ length: resources }, () => ({})),
    secrets_providers: { type: 'cloud', state: { url: 'awskms://alias/k', encryptedkey: 'a2V5' } },
  };
  const commands: string[] = [];
  const run: Runner = (command, args, options) => {
    commands.push(`${command} ${args.join(' ')}`);
    if (command === 'node') return node(command, args, options);
    if (command === 'aws') return { ok: false, stdout: '', stderr: '' };
    if (args[0] === 'destroy') return { ok: false, stdout: destroyOutput, stderr: '' };
    if (args[0] === 'stack' && args[1] === 'export') {
      return { ok: true, stdout: JSON.stringify({ deployment }), stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  const log: string[] = [];
  const projectDir = mkdtempSync(join(tmpdir(), 'pebble-infra-remove-'));
  writeFileSync(join(projectDir, 'Pulumi.yaml'), 'name: acme\nruntime: nodejs\n');
  const ctx: StackContext = {
    run,
    projectDir,
    product: 'acme',
    previewDatabase: true,
    backendUrl: 's3://acme-state/acme/preview?region=xx-test-1',
    secretsProvider: 'awskms://alias/k',
    log: (line) => log.push(line),
  };
  return { ctx, commands, log };
}

/** The CLI's io with PG_ADMIN_URL as ADMIN, capturing what it writes. */
function cliIo() {
  let stderr = '';
  return {
    env: { PATH: process.env.PATH, PG_ADMIN_URL: admin() },
    cwd: tmpdir(),
    stdout: () => {},
    stderr: (text: string) => {
      stderr += text;
    },
    sleep: async () => {},
    stderrText: () => stderr,
  };
}

beforeAll(async () => {
  if (skipped) return;
  await cleanUp();
  await sql(superuser(), `create role ${ADMIN} login createrole createdb password '${ADMIN_PASSWORD}'`);
  await sql(superuser(), `create role ${OLD_ADMIN} login createrole createdb password '${ADMIN_PASSWORD}'`);
  // PR #35's sequence: a first `pulumi up`, then a second `pulumi up --refresh` that replaced the admin's GrantRole.
  // The SQL is what the postgresql provider (3.18.2) runs for each step.
  // First `pulumi up`: Role db-owner, GrantRole db-admin-member (revoke, then grant), Database db, Grant revoke-public.
  // First `pulumi up`: Role db-owner, GrantRole db-admin-member (revoke, then grant), Database db, Grant revoke-public.
  await sql(admin(), `create role ${DATABASE} login password 'owner'`);
  await sql(admin(), `revoke ${DATABASE} from ${ADMIN}`);
  await sql(admin(), `grant ${DATABASE} to ${ADMIN}`);
  await sql(admin(), `create database ${DATABASE} owner ${DATABASE}`);
  await sql(admin(), `revoke all privileges on database ${DATABASE} from public`);
  // Second `pulumi up --refresh`: the GrantRole refresh read the implicit ADMIN OPTION row, so the grant was
  // replaced: the replacement revokes and grants, then deleting the original revokes again.
  await sql(admin(), `revoke ${DATABASE} from ${ADMIN}`);
  await sql(admin(), `grant ${DATABASE} to ${ADMIN}`);
  await sql(admin(), `revoke ${DATABASE} from ${ADMIN}`);
});

afterAll(async () => {
  if (!skipped) await cleanUp();
});

test('after a replaced admin grant, the close job still drops the database and its role', async (ctx) => {
  ctx.skip(skipped, skipReason);
  // What is left matches pebble-stg after run 40009077074: only the implicit membership, which cannot act as the owner.
  expect(
    await sql(
      superuser(),
      `select admin_option, inherit_option, set_option from pg_auth_members
       where roleid = $1::regrole and member = $2::regrole`,
      [DATABASE, ADMIN]
    )
  ).toEqual([{ admin_option: true, inherit_option: false, set_option: false }]);
  // `pulumi destroy` deletes Grant db-revoke-public first, and the provider connects to the database for that.
  await expect(sql(admin().replace('/postgres', `/${DATABASE}`), 'select 1')).rejects.toThrow(
    `permission denied for database "${DATABASE}"`
  );

  const destroyOutput = ` -  postgresql:index:Grant db-revoke-public deleting (0s) error: pq: permission denied for database "${DATABASE}" (42501)`;
  const { ctx: stack, log } = context(destroyOutput);
  remove(stack, STACK, { clearLock: true });

  expect(await exists(DATABASE)).toEqual({ databases: 0, roles: 0 });
  expect(log.slice(0, 2)).toEqual([
    `restored the secrets provider of ${STACK} from its state`,
    `pulumi destroy failed; the SQL drop below removes what the stack held:\n${destroyOutput.trim()}`,
  ]);
});

test('pebble-infra pg-database drop --owner drops the database and keeps the existing owner role', async (ctx) => {
  ctx.skip(skipped, skipReason);
  await sql(admin(), `create role ${OWNER} login password 'owner'`);
  await sql(admin(), `grant ${OWNER} to ${ADMIN}`);
  await sql(admin(), `create database ${OWNED} owner ${OWNER}`);
  const io = cliIo();

  const code = await main(['pg-database', 'drop', OWNED, '--owner', OWNER], io);

  expect([code, io.stderrText(), await exists(OWNED), await exists(OWNER)]).toEqual([
    0,
    `dropped database ${OWNED}\n`,
    { databases: 0, roles: 0 },
    { databases: 0, roles: 1 },
  ]);
});

describe('a preview whose role another admin created (PG_ADMIN_URL rotated)', () => {
  const refusal =
    `refusing: ${ADMIN} cannot drop database ${ROTATED} and role ${ROTATED}: it holds no ADMIN OPTION on role ` +
    `${ROTATED}, the owner, and cannot act as it; ADMIN OPTION on ${ROTATED} is held by ${OLD_ADMIN}. Rerun with ` +
    `that admin's PG_ADMIN_URL (the one in use when ${ROTATED} was created), or have an admin with ADMIN OPTION on ` +
    `${ROTATED} drop them; the Pulumi state is kept for that cleanup.\n`;

  beforeAll(async () => {
    if (skipped) return;
    await sql(oldAdmin(), `create role ${ROTATED} login password 'owner'`);
    await sql(oldAdmin(), `grant ${ROTATED} to ${OLD_ADMIN}`);
    await sql(oldAdmin(), `create database ${ROTATED} owner ${ROTATED}`);
    await sql(oldAdmin(), `revoke all privileges on database ${ROTATED} from public`);
  });

  test('the close job names the admin that can clean up and keeps the stack state', async (ctx) => {
    ctx.skip(skipped, skipReason);
    const { ctx: stack, commands } = context('error: permission denied to revoke role');

    expect(() => remove(stack, ROTATED_STACK, { clearLock: true })).toThrow(`dropping ${ROTATED} failed:\n${refusal}`);
    expect(commands.filter((command) => / stack rm |^aws s3 rm /.test(command))).toEqual([]);
    expect(await exists(ROTATED)).toEqual({ databases: 1, roles: 1 });
  });

  test('the deploy job stops before pulumi up with the same line', (ctx) => {
    ctx.skip(skipped, skipReason);
    const { ctx: stack } = context('', 4);

    expect(() => prepare(stack, ROTATED_STACK, { clearLock: true })).toThrow(
      `${ROTATED} cannot be managed with this PG_ADMIN_URL:\n${refusal}`
    );
  });

  test('pebble-infra pg-database check exits 3 with the same line and drops nothing', async (ctx) => {
    ctx.skip(skipped, skipReason);
    const io = cliIo();

    const code = await main(['pg-database', 'check', ROTATED], io);

    expect([code, io.stderrText(), await exists(ROTATED)]).toEqual([3, refusal, { databases: 1, roles: 1 }]);
  });
});
