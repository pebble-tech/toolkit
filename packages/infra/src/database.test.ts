import * as pulumi from '@pulumi/pulumi';
import { describe, expect, test } from 'vitest';

import { Database, type DatabaseArgs, DatabaseNameError, OPERATORS_GROUP, OwnershipError, Stage } from './index.js';
import { type Registration, runProgram, valueOf } from './testing.js';

const ADMIN_URL = 'postgresql://postgres.abc123:admin-pw@sin.pg.psdb.cloud:6432/postgres?sslmode=require';
const RUNTIME = { role: 'basefresh_app', password: 'runtime-pw' };
type Extra = Omit<DatabaseArgs, 'stage' | 'adminUrl'>;

async function databaseIn(stack: string, args: Extra = {}, product = 'basefresh') {
  return runProgram({ project: product, stack }, async () => {
    const stage = new Stage('stage', { product });
    const database = new Database('db', { stage, adminUrl: ADMIN_URL, ...args });
    return {
      database,
      directUrl: await valueOf(database.directUrl),
      pooledUrl: database.pooledUrl ? await valueOf(database.pooledUrl) : undefined,
      secret: [
        await pulumi.isSecret(database.directUrl),
        database.pooledUrl ? await pulumi.isSecret(database.pooledUrl) : undefined,
      ],
    };
  });
}

/** `type name`, one line per child of the Database component. */
const children = (resources: Registration[]) =>
  resources
    .filter((r) => r.parent.endsWith('pebbletech:index:Database::db'))
    .map((r) => `${r.type} ${r.name}`)
    .sort();
/** Resources of one type, by name: the engine registers them in no fixed order. */
const ofType = (resources: Registration[], type: string) =>
  resources.filter((r) => r.type === type).sort((a, b) => a.name.localeCompare(b.name));
/** The cloud resource (not the component) called `name`. */
const one = (resources: Registration[], name: string) => resources.find((r) => r.custom && r.name === name)!;

describe('Database', () => {
  test('a preview creates its own login role, database and public revoke through an explicit admin provider', async () => {
    const { resources } = await databaseIn('pr-7');
    expect(children(resources)).toEqual([
      'postgresql:index/database:Database db',
      'postgresql:index/grant:Grant db-revoke-public',
      'postgresql:index/grantRole:GrantRole db-admin-member',
      'postgresql:index/grantRole:GrantRole db-operators',
      'postgresql:index/role:Role db-owner',
      'pulumi:providers:postgresql db-admin',
      'random:index/randomPassword:RandomPassword db-owner-password',
    ]);
    expect(one(resources, 'db').inputs).toMatchObject({ name: 'basefresh_pr_7', owner: 'basefresh_pr_7' });
    expect(one(resources, 'db-owner').inputs).toMatchObject({ name: 'basefresh_pr_7', login: true });
    expect(one(resources, 'db-admin-member').inputs).toMatchObject({ role: 'postgres', grantRole: 'basefresh_pr_7' });
    expect(one(resources, 'db-revoke-public').inputs).toMatchObject({
      role: 'public',
      objectType: 'database',
      privileges: [],
    });
  });

  test('the admin provider uses port 5432, verify-full and no superuser, whatever the admin URL says', async () => {
    const { resources } = await databaseIn('pr-7');
    const provider = resources.find((r) => r.type === 'pulumi:providers:postgresql')!;
    expect(provider.inputs).toMatchObject({
      host: 'sin.pg.psdb.cloud',
      port: '5432',
      username: 'postgres.abc123',
      databaseUsername: 'postgres',
      sslmode: 'verify-full',
      superuser: 'false',
    });
  });

  test('a preview URL logs in as <role>.<branch> on the direct port and has no pooled URL', async () => {
    const { result } = await databaseIn('pr-7');
    const url = new URL(result.directUrl);
    expect([url.username, url.password, url.port, url.pathname]).toEqual([
      'basefresh_pr_7.abc123',
      'mock-password-db-owner-password',
      '5432',
      '/basefresh_pr_7',
    ]);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(result.pooledUrl).toBeUndefined();
  });

  test.each([
    ['staging', 'basefresh_stg'],
    ['prod', 'basefresh_prd'],
  ])('%s creates its own owner role <database>_owner and the database owned by it', async (stack, database) => {
    const { resources } = await databaseIn(stack, { runtime: RUNTIME });
    expect(children(resources)).toEqual([
      'postgresql:index/database:Database db',
      'postgresql:index/defaultPrivileges:DefaultPrivileges db-runtime-default-sequences',
      'postgresql:index/defaultPrivileges:DefaultPrivileges db-runtime-default-tables',
      'postgresql:index/grant:Grant db-revoke-public',
      'postgresql:index/grant:Grant db-runtime-connect',
      'postgresql:index/grant:Grant db-runtime-schema',
      'postgresql:index/grant:Grant db-runtime-sequences',
      'postgresql:index/grant:Grant db-runtime-tables',
      'postgresql:index/grantRole:GrantRole db-admin-member',
      'postgresql:index/grantRole:GrantRole db-operators',
      'postgresql:index/role:Role db-owner',
      'pulumi:providers:postgresql db-admin',
      'random:index/randomPassword:RandomPassword db-owner-password',
    ]);
    const owner = `${database}_owner`;
    expect(one(resources, 'db').inputs).toMatchObject({ name: database, owner });
    expect(one(resources, 'db-admin-member').inputs).toMatchObject({ role: 'postgres', grantRole: owner });
    // A login role with a generated password and none of CREATEDB, CREATEROLE or SUPERUSER.
    const role = one(resources, 'db-owner');
    expect(role.inputs).toMatchObject({ name: owner, login: true, password: 'mock-password-db-owner-password' });
    expect(role.secretInputs).toContain('password');
    expect([role.inputs.createDatabase, role.inputs.createRole, role.inputs.superuser]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('the runtime role gets exactly CONNECT, USAGE on public and DML on tables and sequences, and owns nothing', async () => {
    const { resources } = await databaseIn('staging', { runtime: RUNTIME });
    const grants = ofType(resources, 'postgresql:index/grant:Grant').map((r) => [
      r.name,
      r.inputs.role,
      r.inputs.database,
      r.inputs.objectType,
      r.inputs.schema,
      r.inputs.privileges,
    ]);
    expect(grants).toEqual([
      ['db-revoke-public', 'public', 'basefresh_stg', 'database', undefined, []],
      ['db-runtime-connect', 'basefresh_app', 'basefresh_stg', 'database', undefined, ['CONNECT']],
      ['db-runtime-schema', 'basefresh_app', 'basefresh_stg', 'schema', 'public', ['USAGE']],
      ['db-runtime-sequences', 'basefresh_app', 'basefresh_stg', 'sequence', 'public', ['USAGE', 'SELECT', 'UPDATE']],
      [
        'db-runtime-tables',
        'basefresh_app',
        'basefresh_stg',
        'table',
        'public',
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      ],
    ]);
    // The only thing owned is the database, by the component's role; no membership in the runtime role is made.
    expect(ofType(resources, 'postgresql:index/database:Database').map((r) => r.inputs.owner)).toEqual([
      'basefresh_stg_owner',
    ]);
    expect(
      resources.filter((r) => r.inputs.grantRole === 'basefresh_app' || r.inputs.name === 'basefresh_app')
    ).toEqual([]);
  });

  test('tables and sequences the owner creates later are granted to the runtime role by default', async () => {
    const { resources } = await databaseIn('staging', { runtime: RUNTIME });
    expect(ofType(resources, 'postgresql:index/defaultPrivileges:DefaultPrivileges').map((r) => r.inputs)).toEqual([
      {
        database: 'basefresh_stg',
        owner: 'basefresh_stg_owner',
        role: 'basefresh_app',
        schema: 'public',
        objectType: 'sequence',
        privileges: ['USAGE', 'SELECT', 'UPDATE'],
      },
      {
        database: 'basefresh_stg',
        owner: 'basefresh_stg_owner',
        role: 'basefresh_app',
        schema: 'public',
        objectType: 'table',
        privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      },
    ]);
  });

  test('staging: the direct URL is the owner on 5432, the pooled URL is the runtime role on 6432', async () => {
    const { result } = await databaseIn('staging', { runtime: RUNTIME });
    const direct = new URL(result.directUrl);
    const pooled = new URL(result.pooledUrl!);
    expect([direct.username, direct.password, direct.port, direct.pathname]).toEqual([
      'basefresh_stg_owner.abc123',
      'mock-password-db-owner-password',
      '5432',
      '/basefresh_stg',
    ]);
    expect([pooled.username, pooled.password, pooled.port, pooled.pathname]).toEqual([
      'basefresh_app.abc123',
      'runtime-pw',
      '6432',
      '/basefresh_stg',
    ]);
  });

  test('both URLs are secret outputs, and the admin password reaches the provider as a secret', async () => {
    const { result, resources } = await databaseIn('staging', { runtime: RUNTIME });
    expect(result.secret).toEqual([true, true]);
    expect(resources.find((r) => r.type === 'pulumi:providers:postgresql')!.secretInputs).toContain('password');
  });

  test('outputs are registered on the component, with both URLs', async () => {
    const { resources } = await databaseIn('staging', { runtime: RUNTIME });
    const component = resources.find((r) => r.type === 'pebbletech:index:Database')!;
    expect(Object.keys(component.outputs ?? {}).sort()).toEqual([
      'databaseName',
      'directUrl',
      'ownerRole',
      'pooledUrl',
    ]);
    expect(component.outputs).toMatchObject({ databaseName: 'basefresh_stg', ownerRole: 'basefresh_stg_owner' });
  });

  test.each([
    ['pr-7', 'basefresh_pr_7'],
    ['staging', 'basefresh_stg_owner'],
    ['prod', 'basefresh_prd_owner'],
  ])('%s grants the owner role to the operators group, and no argument renames the group', async (stack, owner) => {
    const runtime = stack === 'pr-7' ? {} : { runtime: RUNTIME };
    // Names a caller might try; none is an argument, so the group stays the constant.
    const attempts = { operators: 'x', operatorsGroup: 'x', breakGlass: { role: 'x' }, group: 'x' };
    const { resources } = await databaseIn(stack, { ...runtime, ...attempts } as never);
    expect(ofType(resources, 'postgresql:index/grantRole:GrantRole').map((r) => [r.name, r.inputs])).toEqual([
      ['db-admin-member', { role: 'postgres', grantRole: owner }],
      ['db-operators', { role: 'pebble_operators', grantRole: owner }],
    ]);
    expect(OPERATORS_GROUP).toBe('pebble_operators');
  });

  test.each(['pr-7', 'staging'])(
    '%s: a refresh cannot replace a membership in the owner role (ignoreChanges withAdminOption, there only)',
    async (stack) => {
      const runtime = stack === 'staging' ? { runtime: RUNTIME } : {};
      const { resources } = await databaseIn(stack, runtime);
      const ignoring = resources
        .filter((r) => r.ignoreChanges.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => [r.name, r.ignoreChanges]);
      expect(ignoring).toEqual([
        ['db-admin-member', ['withAdminOption']],
        ['db-operators', ['withAdminOption']],
      ]);
    }
  );

  test('on prod every database resource is protected and retained', async () => {
    const { resources } = await databaseIn('prod', { runtime: RUNTIME });
    const managed = resources.filter((r) => r.custom && !r.type.startsWith('pulumi:providers:'));
    expect(managed).toHaveLength(12);
    for (const resource of managed) {
      expect([resource.type, resource.protect, resource.retainOnDelete]).toEqual([resource.type, true, true]);
    }
    expect(one(managed, 'db').inputs.name).toBe('basefresh_prd');
  });

  test('outside prod nothing is protected', async () => {
    const { resources } = await databaseIn('staging', { runtime: RUNTIME });
    expect(resources.filter((r) => r.protect || r.retainOnDelete)).toEqual([]);
  });

  test('refuses a product id whose database name would pass 63 characters', async () => {
    await expect(databaseIn('staging', { runtime: RUNTIME }, `b${'x'.repeat(60)}`)).rejects.toThrow(DatabaseNameError);
  });

  test('refuses a product id whose owner role name would pass 63 characters', async () => {
    // `<product>_stg` is 59 characters and fits; `<product>_stg_owner` is 65, which Postgres would truncate.
    await expect(databaseIn('staging', { runtime: RUNTIME }, `b${'x'.repeat(54)}`)).rejects.toThrow(
      `owner role "b${'x'.repeat(54)}_stg_owner" must match`
    );
  });

  test.each(['basefresh_stg', 'basefresh_prd'])(
    "a preview cannot name another stage's database: %s is ignored and the name is derived",
    async (name) => {
      const { resources } = await databaseIn('pr-7', { name } as never);
      const databases = resources.filter((r) => r.type === 'postgresql:index/database:Database');
      expect(databases.map((r) => r.inputs.name)).toEqual(['basefresh_pr_7']);
    }
  );

  test.each([
    ['owner', { owner: { role: 'basefresh_app', password: 'pw' } }],
    ['ownerRole', { ownerRole: 'basefresh_stg_owner' }],
    ['ownerPassword', { ownerPassword: 'pw' }],
  ])('refuses a caller-supplied owner name or password: %s', async (key, extra) => {
    await expect(databaseIn('staging', { runtime: RUNTIME, ...extra } as never)).rejects.toThrow(
      `Database takes no owner (${key}): it creates the owner role itself. Since @pebbletech/infra 0.3.0 the PlanetScale-made role is passed as \`runtime\``
    );
    await expect(databaseIn('pr-7', extra as never)).rejects.toThrow(OwnershipError);
  });

  test.each(['basefresh_stg_owner', 'pebble_operators'])(
    'refuses a runtime role that would hold the owner rights: %s',
    async (role) => {
      await expect(databaseIn('staging', { runtime: { role, password: 'pw' } })).rejects.toThrow(
        `the runtime role cannot be ${role}: it would hold the owner's rights`
      );
    }
  );

  test('refuses staging and prod without a runtime role, and a runtime role on a preview', async () => {
    await expect(databaseIn('staging')).rejects.toThrow(OwnershipError);
    await expect(databaseIn('prod')).rejects.toThrow(OwnershipError);
    await expect(databaseIn('pr-7', { runtime: RUNTIME })).rejects.toThrow(
      'a preview takes no runtime role: its generated role is both owner and runtime'
    );
  });

  test('refuses the shared stack', async () => {
    await expect(databaseIn('shared', { runtime: RUNTIME })).rejects.toThrow(OwnershipError);
  });
});
