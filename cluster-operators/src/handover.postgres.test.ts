import { Database, OPERATORS_GROUP, Operators, Stage } from '@pebbletech/infra';
import { type Registration, runProgram } from '@pebbletech/infra/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

import { checkMemberships, clusterOperators } from './cluster-operators.js';

// The handover of a live pebble_operators group from a product's stacks to this program, on a real Postgres with
// admins of the kind PlanetScale gives (not superusers). Pulumi's engine is faked (runProgram); the programs and
// components run for real, and `up` below runs on Postgres the SQL the postgresql provider (3.18.2) runs for what each
// program registered: creates in registration order, then deletes in reverse, as Pulumi orders them.
// The group's name is a constant, so this test creates and drops a role named pebble_operators on DATABASE_URL's
// cluster, which must be local. CI runs it against the verify.yml Postgres service; elsewhere it skips without
// DATABASE_URL.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres', 'db']);
const skipped = !process.env.DATABASE_URL && !process.env.CI;
const skipReason = 'DATABASE_URL is unset: this test needs a local Postgres (CI runs it against a service)';

const id = randomBytes(4).toString('hex');
const PASSWORD = randomBytes(12).toString('hex');
const role = (name: string) => `handover_${name}_${id}`;
/** The product's admin: `ci-admin` on today's clusters. It created the group and granted every membership. */
const PRODUCT_ADMIN = role('product_admin');
/** The cluster admin: no product uses it. */
const CLUSTER_ADMIN = role('cluster_admin');
/** A second product's own admin, which never touches the group. */
const OTHER_ADMIN = role('other_admin');
const [M1, M2, M3, M4] = ['m1', 'm2', 'm3', 'm4'].map(role) as [string, string, string, string];
const PRODUCT = `acme${id}`;
const OTHER = `zeta${id}`;
const PRODUCT_DB = `${PRODUCT}_stg`;
const OTHER_DB = `${OTHER}_stg`;
const RUNTIMES = [role('runtime'), role('other_runtime')] as const;

function url(user?: string, database = 'postgres'): string {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is unset: CI must run this test against Postgres');
  const parsed = new URL(process.env.DATABASE_URL);
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`this test creates roles; DATABASE_URL must be a local Postgres (got ${parsed.hostname})`);
  }
  parsed.pathname = `/${database}`;
  if (user) {
    parsed.username = user;
    parsed.password = PASSWORD;
  }
  return parsed.toString();
}

async function sql<T extends pg.QueryResultRow>(as: string, query: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url(as === 'superuser' ? undefined : as) });
  await client.connect();
  try {
    return (await client.query<T>(query, values)).rows;
  } finally {
    await client.end();
  }
}

const q = (name: string) => (name === 'public' ? 'PUBLIC' : `"${name.replaceAll('"', '""')}"`);

// ---- What the postgresql provider runs, per resource type ----

/** Registered for the runtime role's table rights: Postgres runs them, but they never touch the group. */
const NOT_ABOUT_THE_GROUP = (r: Registration) =>
  r.type === 'postgresql:index/defaultPrivileges:DefaultPrivileges' ||
  (r.type === 'postgresql:index/grant:Grant' && r.inputs.objectType !== 'database');

async function create(admin: string, r: Registration): Promise<void> {
  const { inputs } = r;
  switch (r.type) {
    case 'postgresql:index/role:Role':
      // An import only reads the existing role.
      if (r.importId) {
        const found = await sql(admin, 'select 1 from pg_roles where rolname = $1', [r.importId]);
        if (found.length === 0) throw new Error(`import of ${r.importId} failed: it does not exist`);
        return;
      }
      await sql(
        admin,
        `create role ${q(inputs.name)} ${inputs.login ? 'login' : 'nologin'}` +
          (inputs.password ? ` password '${inputs.password}'` : '')
      );
      return;
    case 'postgresql:index/grantRole:GrantRole':
      // The provider revokes, then grants, in one transaction.
      await sql(
        admin,
        `begin; revoke ${q(inputs.grantRole)} from ${q(inputs.role)}; ` +
          `grant ${q(inputs.grantRole)} to ${q(inputs.role)}${inputs.withAdminOption ? ' with admin option' : ''}; commit`
      );
      return;
    case 'postgresql:index/database:Database':
      await sql(admin, `create database ${q(inputs.name)} owner ${q(inputs.owner)}`);
      return;
    case 'postgresql:index/grant:Grant': {
      const on = `on database ${q(inputs.database)}`;
      await sql(admin, `revoke all privileges ${on} from ${q(inputs.role)}`);
      if (inputs.privileges.length > 0)
        await sql(admin, `grant ${inputs.privileges.join(', ')} ${on} to ${q(inputs.role)}`);
      return;
    }
    case 'random:index/randomPassword:RandomPassword':
      return;
    default:
      throw new Error(`no provider SQL for ${r.type} ${r.name}`);
  }
}

async function destroy(admin: string, r: Registration): Promise<void> {
  if (r.retainOnDelete) return;
  const { inputs } = r;
  switch (r.type) {
    case 'postgresql:index/grantRole:GrantRole':
      await sql(admin, `revoke ${q(inputs.grantRole)} from ${q(inputs.role)}`);
      return;
    case 'postgresql:index/role:Role':
      await sql(admin, `drop role ${q(inputs.name)}`);
      return;
    case 'postgresql:index/database:Database':
      await sql(admin, `drop database ${q(inputs.name)}`);
      return;
    case 'postgresql:index/grant:Grant':
      await sql(admin, `revoke all privileges on database ${q(inputs.database)} from ${q(inputs.role)}`);
      return;
    case 'random:index/randomPassword:RandomPassword':
      return;
    default:
      throw new Error(`no provider SQL for deleting ${r.type} ${r.name}`);
  }
}

/** One Pulumi stack: the admin its provider connects as, and what its state holds, by URN. */
interface Stack {
  admin: string;
  state: Map<string, Registration>;
}

const newStack = (admin: string): Stack => ({ admin, state: new Map() });

/**
 * `pulumi up`: runs the program against the fake engine, then applies the difference from the stack's state on
 * Postgres, updating the state as each step lands. A protected resource stops the update when its delete comes up:
 * the deletes before it have run, as in Pulumi.
 */
async function up(stack: Stack, options: { project: string; stack: string }, program: () => unknown) {
  const { resources } = await runProgram(options, program);
  const next = new Map(
    resources
      .filter((r) => r.custom && !r.type.startsWith('pulumi:providers:') && !NOT_ABOUT_THE_GROUP(r))
      .map((r) => [r.urn, r])
  );
  for (const [urn, r] of next) {
    if (!stack.state.has(urn)) await create(stack.admin, r);
    stack.state.set(urn, r);
  }
  for (const r of [...stack.state.values()].filter((r) => !next.has(r.urn)).reverse()) {
    if (r.protect) throw new Error(`unable to delete ${r.name}: it is protected`);
    await destroy(stack.admin, r);
    stack.state.delete(r.urn);
  }
}

/** `pulumi refresh`: a membership the provider no longer reads back leaves the state, so the next `up` recreates it. */
async function refresh(stack: Stack): Promise<void> {
  for (const [urn, r] of stack.state) {
    if (r.type !== 'postgresql:index/grantRole:GrantRole') continue;
    const read = await sql(
      stack.admin,
      `select admin_option from pg_auth_members
       where pg_get_userbyid(member) = $1 and pg_get_userbyid(roleid) = $2`,
      [r.inputs.role, r.inputs.grantRole]
    );
    if (read.length === 0) stack.state.delete(urn);
  }
}

/** `pulumi state unprotect <urn>`. */
function unprotect(stack: Stack, name: string): void {
  const r = [...stack.state.values()].find((resource) => resource.name === name);
  if (!r) throw new Error(`no ${name} in the state`);
  r.protect = false;
}

// ---- The programs ----

const productShared = (members?: string[]) => () => {
  const stage = new Stage('stage', { product: PRODUCT });
  // Today's product program, until the handover removes this line.
  if (members) new Operators('operators', { stage, adminUrl: url(PRODUCT_ADMIN), members });
};

const productStaging = (product: string, admin: string, runtime: string) => () => {
  const stage = new Stage('stage', { product });
  new Database('db', { stage, adminUrl: url(admin), runtime: { role: runtime, password: PASSWORD } });
};

const clusterProgram =
  (members: string[], adoptExisting = false) =>
  () =>
    clusterOperators({ cluster: 'pebble-stg', adoptExisting, members, adminUrl: url(CLUSTER_ADMIN) });

const CLUSTER_STACK = { project: 'pebble-cluster-operators', stack: 'pebble-stg' };

// ---- What Postgres says ----

/** Every membership in the group that gives access, as `member by grantor`. */
async function memberships(): Promise<string[]> {
  const rows = await sql<{ line: string }>(
    'superuser',
    `select pg_get_userbyid(member) || ' by ' || pg_get_userbyid(grantor) as line from pg_auth_members
     where roleid = $1::regrole and (inherit_option or set_option) order by 1`,
    [OPERATORS_GROUP]
  );
  return rows.map((row) => row.line);
}

/** Whether `member` can connect to `database`: the access the group gives through each database's owner. */
async function connects(member: string, database: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url(member, database) });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch (error) {
    if (/permission denied|CONNECT privilege/.test(String(error))) return false;
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function access(members: string[], database = PRODUCT_DB): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const member of members) result[member] = await connects(member, database);
  return result;
}

const all = (members: string[], value: boolean) => Object.fromEntries(members.map((member) => [member, value]));

// ---- Fixture: today's cluster ----

async function cleanUp(): Promise<void> {
  for (const database of [PRODUCT_DB, OTHER_DB])
    await sql('superuser', `drop database if exists ${q(database)} with (force)`);
  const roles = [
    OPERATORS_GROUP,
    `${PRODUCT_DB}_owner`,
    `${OTHER_DB}_owner`,
    M1,
    M2,
    M3,
    M4,
    ...RUNTIMES,
    CLUSTER_ADMIN,
    OTHER_ADMIN,
    PRODUCT_ADMIN,
  ];
  for (const name of roles) await sql('superuser', `drop role if exists ${q(name)}`);
}

/**
 * Today: the product admin created the group from the product's `shared` stack and granted M1 and M2, and the
 * product's `staging` stack owns a database whose owner role is granted to the group. The cluster admin exists, made
 * by hand (on PlanetScale, by `pscale role create`), and holds nothing.
 */
async function today() {
  await cleanUp();
  for (const admin of [PRODUCT_ADMIN, OTHER_ADMIN]) {
    await sql('superuser', `create role ${q(admin)} login createrole createdb password '${PASSWORD}'`);
  }
  await sql('superuser', `create role ${q(CLUSTER_ADMIN)} login createrole password '${PASSWORD}'`);
  for (const login of [M1, M2, M3, M4, ...RUNTIMES]) {
    await sql('superuser', `create role ${q(login)} login password '${PASSWORD}'`);
  }
  const shared = newStack(PRODUCT_ADMIN);
  const staging = newStack(PRODUCT_ADMIN);
  await up(shared, { project: PRODUCT, stack: 'shared' }, productShared([M1, M2]));
  await up(staging, { project: PRODUCT, stack: 'staging' }, productStaging(PRODUCT, PRODUCT_ADMIN, RUNTIMES[0]));
  return { shared, staging, cluster: newStack(CLUSTER_ADMIN) };
}

/** The one grant the product admin makes first: administration of the group, with no access through it. */
const grantClusterAdmin = () =>
  sql(PRODUCT_ADMIN, `grant ${OPERATORS_GROUP} to ${q(CLUSTER_ADMIN)} with admin option, inherit false, set false`);

describe('the handover of pebble_operators to the cluster program', () => {
  beforeEach(async () => {
    if (!skipped) await cleanUp();
  });
  afterAll(async () => {
    if (!skipped) await cleanUp();
  });

  test("the cluster admin takes the group and its members over with no gap in anyone's access", async (ctx) => {
    ctx.skip(skipped, skipReason);
    const { shared, staging, cluster } = await today();
    expect(await memberships(), 'today').toEqual([`${M1} by ${PRODUCT_ADMIN}`, `${M2} by ${PRODUCT_ADMIN}`]);
    expect(await access([M1, M2, CLUSTER_ADMIN]), 'today').toEqual({ ...all([M1, M2], true), [CLUSTER_ADMIN]: false });

    // 1. The product admin lets the cluster admin administer the group. ADMIN OPTION only: the cluster admin can
    //    grant and revoke the group, and cannot act as it.
    await grantClusterAdmin();
    expect(await access([M1, M2, CLUSTER_ADMIN]), 'step 1').toEqual({ ...all([M1, M2], true), [CLUSTER_ADMIN]: false });

    // 2. The cluster stack's first apply adopts the group and grants every member again, as the cluster admin. The
    //    product's grants are still there, so the check warns about each one and refuses nothing.
    expect(await checkMemberships(url(CLUSTER_ADMIN), [M1, M2]), 'step 2 check').toEqual([
      `${M1}'s membership in pebble_operators is also granted by ${PRODUCT_ADMIN} (a product stack's Operators or a hand grant): removing ${M1} from members will not take it away until ${PRODUCT_ADMIN} revokes it`,
      `${M2}'s membership in pebble_operators is also granted by ${PRODUCT_ADMIN} (a product stack's Operators or a hand grant): removing ${M2} from members will not take it away until ${PRODUCT_ADMIN} revokes it`,
    ]);
    await up(cluster, CLUSTER_STACK, clusterProgram([M1, M2], true));
    expect(await memberships(), 'step 2').toEqual([
      `${M1} by ${CLUSTER_ADMIN}`,
      `${M1} by ${PRODUCT_ADMIN}`,
      `${M2} by ${CLUSTER_ADMIN}`,
      `${M2} by ${PRODUCT_ADMIN}`,
    ]);
    expect(await access([M1, M2]), 'step 2').toEqual(all([M1, M2], true));

    // 3. The product's shared stack drops Operators, after `pulumi state unprotect` of the group. Its apply forgets
    //    the group (kept: retainOnDelete), and its member grants' deletes revoke the product admin's own rows. The
    //    cluster admin's rows keep everyone in.
    unprotect(shared, 'operators-group');
    await up(shared, { project: PRODUCT, stack: 'shared' }, productShared());
    expect(
      [...shared.state.values()].map((r) => r.name),
      'step 3: nothing of the group left in the product state'
    ).toEqual([]);
    expect(await memberships(), 'step 3').toEqual([`${M1} by ${CLUSTER_ADMIN}`, `${M2} by ${CLUSTER_ADMIN}`]);
    expect(await access([M1, M2]), 'step 3').toEqual(all([M1, M2], true));
    expect(
      await sql('superuser', 'select 1 from pg_roles where rolname = $1', [OPERATORS_GROUP]),
      'step 3: group kept'
    ).toHaveLength(1);

    // 4. The flag goes off; the next apply changes nothing, and the check has nothing left to warn about.
    expect(await checkMemberships(url(CLUSTER_ADMIN), [M1, M2]), 'step 4 check').toEqual([]);
    const held = [...cluster.state.keys()];
    await up(cluster, CLUSTER_STACK, clusterProgram([M1, M2]));
    expect([...cluster.state.keys()], 'step 4: same resources').toEqual(held);

    // 5. The product's Database grant to the group still applies: a refresh reads it back, a later up keeps it, and
    //    a second product, with its own admin and no rights on the group, grants its new database to it.
    await refresh(staging);
    expect(
      [...staging.state.values()].map((r) => r.name),
      'step 5: refresh keeps db-operators'
    ).toContain('db-operators');
    await up(staging, { project: PRODUCT, stack: 'staging' }, productStaging(PRODUCT, PRODUCT_ADMIN, RUNTIMES[0]));
    const other = newStack(OTHER_ADMIN);
    await up(other, { project: OTHER, stack: 'staging' }, productStaging(OTHER, OTHER_ADMIN, RUNTIMES[1]));
    expect([await access([M1, M2]), await access([M1, M2], OTHER_DB)], 'step 5').toEqual([
      all([M1, M2], true),
      all([M1, M2], true),
    ]);

    // 6. The cluster admin adds M3 and removes M1, and the removal takes effect.
    await up(cluster, CLUSTER_STACK, clusterProgram([M2, M3]));
    expect(await memberships(), 'step 6').toEqual([`${M2} by ${CLUSTER_ADMIN}`, `${M3} by ${CLUSTER_ADMIN}`]);
    expect([await access([M1, M2, M3]), await access([M1, M2, M3], OTHER_DB)], 'step 6').toEqual([
      { [M1]: false, [M2]: true, [M3]: true },
      { [M1]: false, [M2]: true, [M3]: true },
    ]);
  });

  test('a product apply that forgets the unprotect revokes its member grants, then stops at the group', async (ctx) => {
    ctx.skip(skipped, skipReason);
    const { shared, cluster } = await today();
    await grantClusterAdmin();
    await up(cluster, CLUSTER_STACK, clusterProgram([M1, M2], true));
    await expect(up(shared, { project: PRODUCT, stack: 'shared' }, productShared())).rejects.toThrow(
      'unable to delete operators-group: it is protected'
    );
    expect([await memberships(), [...shared.state.values()].map((r) => r.name)]).toEqual([
      [`${M1} by ${CLUSTER_ADMIN}`, `${M2} by ${CLUSTER_ADMIN}`],
      ['operators-group'],
    ]);
    unprotect(shared, 'operators-group');
    await up(shared, { project: PRODUCT, stack: 'shared' }, productShared());
    expect([...shared.state.values()]).toEqual([]);
  });

  test("a membership the product admin granted survives the cluster admin's revoke, and the cluster program refuses it", async (ctx) => {
    ctx.skip(skipped, skipReason);
    const { shared, cluster } = await today();
    await grantClusterAdmin();
    await up(cluster, CLUSTER_STACK, clusterProgram([M1, M2], true));
    // The wrong handover: the product forgets its grants (`pulumi state delete`) instead of applying their deletes.
    shared.state.clear();
    // On PostgreSQL 16+ the cluster admin's REVOKE removes only its own row: M1 keeps the product admin's.
    await sql(CLUSTER_ADMIN, `revoke ${OPERATORS_GROUP} from ${q(M1)}`);
    expect([await memberships(), await access([M1])]).toEqual([
      [`${M1} by ${PRODUCT_ADMIN}`, `${M2} by ${CLUSTER_ADMIN}`, `${M2} by ${PRODUCT_ADMIN}`],
      { [M1]: true },
    ]);
    // So removing M1 from the list is refused, naming the grant and the line that revokes it.
    await expect(up(cluster, CLUSTER_STACK, clusterProgram([M2]))).rejects.toThrow(
      `pebble_operators has memberships this program cannot revoke, for roles not in members:\n` +
        `- ${M1}, granted by ${PRODUCT_ADMIN}; as ${PRODUCT_ADMIN}: REVOKE pebble_operators FROM "${M1}";`
    );
    await sql(PRODUCT_ADMIN, `revoke ${OPERATORS_GROUP} from ${q(M1)}`);
    expect(await access([M1])).toEqual({ [M1]: false });
  });

  test('a product stack that still constructs Operators beside the cluster program is refused or fails at apply', async (ctx) => {
    ctx.skip(skipped, skipReason);
    const { shared, cluster } = await today();
    await grantClusterAdmin();
    await up(cluster, CLUSTER_STACK, clusterProgram([M1, M2], true));
    // The product's list goes on granting: a name it adds is one the cluster program cannot revoke, and its next
    // apply is refused.
    await up(shared, { project: PRODUCT, stack: 'shared' }, productShared([M1, M2, M4]));
    await expect(up(cluster, CLUSTER_STACK, clusterProgram([M1, M2]))).rejects.toThrow(
      `- ${M4}, granted by ${PRODUCT_ADMIN}; as ${PRODUCT_ADMIN}: REVOKE pebble_operators FROM "${M4}";`
    );
    // A product stack that constructs Operators afresh on the cluster fails creating the group, which exists.
    await expect(
      up(newStack(OTHER_ADMIN), { project: OTHER, stack: 'shared' }, () => {
        const stage = new Stage('stage', { product: OTHER });
        new Operators('operators', { stage, adminUrl: url(OTHER_ADMIN), members: [M3] });
      })
    ).rejects.toThrow('role "pebble_operators" already exists');
    expect(await memberships()).not.toContain(`${M3} by ${OTHER_ADMIN}`);
  });

  test("the cluster admin's own membership carries no access: one granted with access is refused", async (ctx) => {
    ctx.skip(skipped, skipReason);
    await today();
    await sql(PRODUCT_ADMIN, `grant ${OPERATORS_GROUP} to ${q(CLUSTER_ADMIN)} with admin option`);
    await expect(checkMemberships(url(CLUSTER_ADMIN), [M1, M2])).rejects.toThrow(
      `- ${CLUSTER_ADMIN}, this cluster admin, holds access granted by ${PRODUCT_ADMIN}; as ${PRODUCT_ADMIN}: ` +
        `GRANT pebble_operators TO "${CLUSTER_ADMIN}" WITH INHERIT FALSE, SET FALSE;`
    );
    await sql(PRODUCT_ADMIN, `grant ${OPERATORS_GROUP} to ${q(CLUSTER_ADMIN)} with inherit false, set false`);
    expect(await checkMemberships(url(CLUSTER_ADMIN), [M1, M2])).toHaveLength(2);
  });

  test("the product admin cannot be dropped, or its grant revoked, while the cluster admin's ADMIN OPTION rests on it", async (ctx) => {
    ctx.skip(skipped, skipReason);
    const { shared, cluster } = await today();
    await grantClusterAdmin();
    await up(cluster, CLUSTER_STACK, clusterProgram([M1, M2], true));
    unprotect(shared, 'operators-group');
    await up(shared, { project: PRODUCT, stack: 'shared' }, productShared());
    await expect(sql('superuser', `drop role ${q(PRODUCT_ADMIN)}`)).rejects.toThrow(
      `role "${PRODUCT_ADMIN}" cannot be dropped because some objects depend on it`
    );
    await expect(sql(PRODUCT_ADMIN, `revoke ${OPERATORS_GROUP} from ${q(CLUSTER_ADMIN)}`)).rejects.toThrow(
      'dependent privileges exist'
    );
    // With CASCADE the revoke takes every membership the cluster admin granted with it.
    await sql(PRODUCT_ADMIN, `begin; revoke ${OPERATORS_GROUP} from ${q(CLUSTER_ADMIN)} cascade; commit`);
    expect(await access([M1, M2])).toEqual(all([M1, M2], false));
  });

  test('on a fresh cluster the cluster program creates the group, and no product admin holds anything on it', async (ctx) => {
    ctx.skip(skipped, skipReason);
    await sql('superuser', `create role ${q(CLUSTER_ADMIN)} login createrole password '${PASSWORD}'`);
    await sql('superuser', `create role ${q(OTHER_ADMIN)} login createrole createdb password '${PASSWORD}'`);
    for (const login of [M1, RUNTIMES[1]])
      await sql('superuser', `create role ${q(login)} login password '${PASSWORD}'`);
    await up(newStack(CLUSTER_ADMIN), CLUSTER_STACK, clusterProgram([M1]));
    await up(
      newStack(OTHER_ADMIN),
      { project: OTHER, stack: 'staging' },
      productStaging(OTHER, OTHER_ADMIN, RUNTIMES[1])
    );
    expect([await memberships(), await access([M1], OTHER_DB)]).toEqual([
      [`${M1} by ${CLUSTER_ADMIN}`],
      { [M1]: true },
    ]);
    const admins = await sql<{ member: string }>(
      'superuser',
      `select pg_get_userbyid(member) as member from pg_auth_members where roleid = $1::regrole and admin_option`,
      [OPERATORS_GROUP]
    );
    expect(admins.map((row) => row.member)).toEqual([CLUSTER_ADMIN]);
  });
});
