import * as pulumi from '@pulumi/pulumi';
import { describe, expect, test } from 'vitest';

import { Database, type DatabaseArgs, DatabaseNameError, OPERATORS_GROUP, OwnershipError, Stage } from './index.js';
import { type Registration, runProgram, valueOf } from './testing.js';

const ADMIN_URL = 'postgresql://postgres.abc123:admin-pw@sin.pg.psdb.cloud:6432/postgres?sslmode=require';
const RUNTIME = { role: 'basefresh_app', password: 'runtime-pw' };
type Extra = Omit<DatabaseArgs, 'stage' | 'adminUrl'>;

async function databaseIn(stack: string, args: Extra = {}, product = 'basefresh', adminUrl = ADMIN_URL) {
  return runProgram({ project: product, stack }, async () => {
    const stage = new Stage('stage', { product });
    const database = new Database('db', { stage, adminUrl, ...args });
    return {
      database,
      directUrl: await valueOf(database.directUrl),
      directWaitsFor: await dependencies(database.directUrl),
      pooledUrl: database.pooledUrl ? await valueOf(database.pooledUrl) : undefined,
      pooledWaitsFor: database.pooledUrl ? await dependencies(database.pooledUrl) : [],
      secret: [
        await pulumi.isSecret(database.directUrl),
        database.pooledUrl ? await pulumi.isSecret(database.pooledUrl) : undefined,
      ],
    };
  });
}

/** The names of the resources an output waits for. */
async function dependencies(output: pulumi.Output<string>): Promise<string[]> {
  const all = await (output as unknown as { allResources(): Promise<Set<pulumi.Resource>> }).allResources();
  const urns = await Promise.all([...all].map((resource) => valueOf(resource.urn)));
  return urns.map((urn) => urn.split('::').at(-1)!).sort();
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

  test.each([
    [
      'a non-enumerable own property',
      'ownerRole',
      (valid: DatabaseArgs) => Object.defineProperty({ ...valid }, 'ownerRole', { value: 'chosen' }),
    ],
    [
      'an inherited property',
      'ownerPassword',
      (valid: DatabaseArgs) => Object.assign(Object.create({ ownerPassword: 'chosen' }), valid),
    ],
  ])('refuses an owner argument passed as %s', async (_, key, shape) => {
    const program = () =>
      runProgram({ project: 'basefresh', stack: 'staging' }, () => {
        const stage = new Stage('stage', { product: 'basefresh' });
        new Database('db', shape({ stage, adminUrl: ADMIN_URL, runtime: RUNTIME }));
      });
    await expect(program()).rejects.toThrow(`Database takes no owner (${key})`);
  });

  test.each(['basefresh_stg_owner', 'pebble_operators'])(
    'refuses a runtime role that would hold the owner rights: %s',
    async (role) => {
      await expect(databaseIn('staging', { runtime: { role, password: 'pw' } })).rejects.toThrow(
        `the runtime role cannot be ${role}: it would hold the owner's rights`
      );
    }
  );

  test('refuses a runtime role on a preview', async () => {
    await expect(databaseIn('pr-7', { runtime: RUNTIME })).rejects.toThrow(
      'a preview takes no runtime role: its generated role is both owner and runtime'
    );
  });

  test('refuses a product id whose made runtime role name would pass 63 characters', async () => {
    // `<product>_stg_owner` is 62 characters and fits; `<product>_stg_runtime` is 64.
    const product = `b${'x'.repeat(51)}`;
    await expect(databaseIn('staging', {}, product)).rejects.toThrow(
      `runtime role "${product}_stg_runtime" must match`
    );
    await expect(databaseIn('staging', { runtime: RUNTIME }, product)).resolves.toBeDefined();
  });

  test.each([
    ['staging', 'basefresh_stg'],
    ['prod', 'basefresh_prd'],
  ])('%s without `runtime` makes <database>_runtime, a plain login role, and grants it', async (stack, database) => {
    const { resources } = await databaseIn(stack);
    const made = `${database}_runtime`;
    expect(children(resources)).toEqual(
      [
        ...children((await databaseIn(stack, { runtime: RUNTIME })).resources),
        'postgresql:index/role:Role db-runtime',
        'random:index/randomPassword:RandomPassword db-runtime-password',
      ].sort()
    );
    const role = one(resources, 'db-runtime');
    expect(role.inputs).toMatchObject({ name: made, login: true, password: 'mock-password-db-runtime-password' });
    expect(role.secretInputs).toContain('password');
    expect([role.inputs.createDatabase, role.inputs.createRole, role.inputs.superuser]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const granted = [
      ...ofType(resources, 'postgresql:index/grant:Grant'),
      ...ofType(resources, 'postgresql:index/defaultPrivileges:DefaultPrivileges'),
    ].filter((r) => r.name.startsWith('db-runtime-'));
    expect(granted.map((r) => r.inputs.role)).toEqual(Array(6).fill(made));
    // It is a member of nothing and nothing is a member of it.
    const memberships = ofType(resources, 'postgresql:index/grantRole:GrantRole');
    expect(memberships.filter((r) => [r.inputs.role, r.inputs.grantRole].includes(made))).toEqual([]);
  });

  test('without `runtime` the pooled URL is the made role on 6432 with its generated password, as a secret', async () => {
    const { result } = await databaseIn('staging');
    const pooled = new URL(result.pooledUrl!);
    expect([pooled.username, pooled.password, pooled.port, pooled.pathname]).toEqual([
      'basefresh_stg_runtime.abc123',
      'mock-password-db-runtime-password',
      '6432',
      '/basefresh_stg',
    ]);
    expect(result.secret).toEqual([true, true]);
  });

  test.each([
    ['the made role', {}],
    ['a passed role', { runtime: RUNTIME }],
  ])(
    'the pooled URL waits for every grant to %s, so no consumer gets it before the role can log in',
    async (_, args) => {
      const { result } = await databaseIn('staging', args);
      expect(result.pooledWaitsFor).toEqual(
        expect.arrayContaining([
          'db-runtime-connect',
          'db-runtime-default-sequences',
          'db-runtime-default-tables',
          'db-runtime-schema',
          'db-runtime-sequences',
          'db-runtime-tables',
        ])
      );
    }
  );

  test('on prod the made runtime role and its password are protected and retained too', async () => {
    const { resources } = await databaseIn('prod');
    const managed = resources.filter((r) => r.custom && !r.type.startsWith('pulumi:providers:'));
    expect(managed).toHaveLength(14);
    for (const resource of managed) {
      expect([resource.type, resource.protect, resource.retainOnDelete]).toEqual([resource.type, true, true]);
    }
  });

  test('refuses the shared stack', async () => {
    await expect(databaseIn('shared', { runtime: RUNTIME })).rejects.toThrow(OwnershipError);
  });
});

describe('Database schemas', () => {
  /** Name, schema and dependencies (as names) of each grant and default privilege. */
  const granted = (resources: Registration[]) => {
    const nameOf = new Map(resources.map((r) => [r.urn, r.name]));
    return [
      ...ofType(resources, 'postgresql:index/grant:Grant'),
      ...ofType(resources, 'postgresql:index/defaultPrivileges:DefaultPrivileges'),
    ]
      .filter((r) => r.name.startsWith('db-runtime-') && r.name !== 'db-runtime-connect')
      .map((r) => [
        r.name,
        r.inputs.schema,
        r.inputs.objectType,
        r.inputs.privileges,
        r.dependencies.map((u) => nameOf.get(u)).sort(),
      ]);
  };

  test('public and cms: public keeps its grants and names, cms is created, owned by the owner, and granted alike', async () => {
    const { resources, result } = await databaseIn('staging', { runtime: RUNTIME, schemas: ['public', 'cms'] });
    const before = children((await databaseIn('staging', { runtime: RUNTIME })).resources);
    expect(children(resources)).toEqual(
      [
        ...before,
        'postgresql:index/schema:Schema db-schema-cms',
        'postgresql:index/grant:Grant db-runtime-schema-cms',
        'postgresql:index/grant:Grant db-runtime-tables-cms',
        'postgresql:index/grant:Grant db-runtime-sequences-cms',
        'postgresql:index/defaultPrivileges:DefaultPrivileges db-runtime-default-tables-cms',
        'postgresql:index/defaultPrivileges:DefaultPrivileges db-runtime-default-sequences-cms',
      ].sort()
    );
    const schema = one(resources, 'db-schema-cms');
    expect(schema.inputs).toEqual({ name: 'cms', database: 'basefresh_stg', owner: 'basefresh_stg_owner' });
    // Creating a schema owned by the owner role needs the admin's SET ROLE membership, and the database.
    const nameOf = new Map(resources.map((r) => [r.urn, r.name]));
    expect(schema.dependencies.map((urn) => nameOf.get(urn)).sort()).toEqual(['db', 'db-admin-member']);
    const tables = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
    const sequences = ['USAGE', 'SELECT', 'UPDATE'];
    expect(granted(resources).filter(([name]) => String(name).endsWith('-cms'))).toEqual([
      ['db-runtime-schema-cms', 'cms', 'schema', ['USAGE'], ['db', 'db-schema-cms']],
      ['db-runtime-sequences-cms', 'cms', 'sequence', sequences, ['db', 'db-schema-cms']],
      ['db-runtime-tables-cms', 'cms', 'table', tables, ['db', 'db-schema-cms']],
      ['db-runtime-default-sequences-cms', 'cms', 'sequence', sequences, ['db', 'db-schema-cms']],
      ['db-runtime-default-tables-cms', 'cms', 'table', tables, ['db', 'db-schema-cms']],
    ]);
    expect(one(resources, 'db-runtime-default-tables-cms').inputs).toMatchObject({
      owner: 'basefresh_stg_owner',
      role: 'basefresh_app',
    });
    expect(result.pooledWaitsFor).toEqual(
      expect.arrayContaining(['db-runtime-schema-cms', 'db-runtime-default-tables-cms'])
    );
  });

  test('cms alone grants nothing on public; the database revoke and CONNECT stay', async () => {
    const { resources } = await databaseIn('staging', { schemas: ['cms'] });
    expect(granted(resources).map(([name, schema]) => [name, schema])).toEqual([
      ['db-runtime-schema-cms', 'cms'],
      ['db-runtime-sequences-cms', 'cms'],
      ['db-runtime-tables-cms', 'cms'],
      ['db-runtime-default-sequences-cms', 'cms'],
      ['db-runtime-default-tables-cms', 'cms'],
    ]);
    expect(one(resources, 'db-revoke-public').inputs).toMatchObject({ role: 'public', privileges: [] });
    expect(one(resources, 'db-runtime-connect').inputs).toMatchObject({
      role: 'basefresh_stg_runtime',
      privileges: ['CONNECT'],
    });
  });

  test('a preview creates the schema, owned by its one role, dropped with what it holds, and grants nothing', async () => {
    const { resources } = await databaseIn('pr-7', { schemas: ['public', 'cms'] });
    // The whole database goes with the preview, so its schema's tables must not block the destroy.
    expect(one(resources, 'db-schema-cms').inputs).toEqual({
      dropCascade: true,
      name: 'cms',
      database: 'basefresh_pr_7',
      owner: 'basefresh_pr_7',
    });
    expect(granted(resources)).toEqual([]);
  });

  test('on prod the schema and its grants are protected and retained', async () => {
    const { resources } = await databaseIn('prod', { runtime: RUNTIME, schemas: ['public', 'cms'] });
    const added = resources.filter((r) => r.name.endsWith('-cms'));
    expect(added.map((r) => [r.name, r.protect, r.retainOnDelete]).sort()).toEqual(
      [
        'db-runtime-default-sequences-cms',
        'db-runtime-default-tables-cms',
        'db-runtime-schema-cms',
        'db-runtime-sequences-cms',
        'db-runtime-tables-cms',
        'db-schema-cms',
      ].map((name) => [name, true, true])
    );
  });

  test('only a preview drops a schema with what it holds; staging and prod refuse to drop one that is not empty', async () => {
    const cascade = async (stack: string) =>
      one((await databaseIn(stack, { schemas: ['public', 'cms'] })).resources, 'db-schema-cms').inputs.dropCascade;
    expect([await cascade('pr-7'), await cascade('staging'), await cascade('prod')]).toEqual([
      true,
      undefined,
      undefined,
    ]);
  });

  test.each(['pr-7', 'staging'])('%s: the direct URL waits for each schema, so a migration finds it', async (stack) => {
    const { result } = await databaseIn(stack, { schemas: ['public', 'cms', 'audit'] });
    expect(result.directWaitsFor).toEqual(expect.arrayContaining(['db-schema-audit', 'db-schema-cms']));
  });

  test('refuses schemas given as a string, not a list', async () => {
    await expect(databaseIn('staging', { schemas: 'cms' } as never)).rejects.toThrow(
      'schemas must be a list of schema names'
    );
    await expect(databaseIn('pr-7', { schemas: 'cms' } as never)).rejects.toThrow(DatabaseNameError);
  });

  test.each([
    [['Cms'], 'schema "Cms" must match'],
    [['my-cms'], 'schema "my-cms" must match'],
    [['pg_cms'], 'schema "pg_cms" is reserved by Postgres'],
    [['information_schema'], 'schema "information_schema" is reserved by Postgres'],
    [[], 'schemas cannot be empty'],
    [['cms', 'public', 'cms'], 'schema cms is listed twice'],
  ])('refuses schemas %j', async (schemas, message) => {
    await expect(databaseIn('staging', { schemas })).rejects.toThrow(DatabaseNameError);
    await expect(databaseIn('pr-7', { schemas })).rejects.toThrow(message);
  });
});

describe('Database on Neon', () => {
  const NEON_HOST = 'ep-cool-123.ap-southeast-1.aws.neon.tech';
  const NEON_URL = `postgresql://site.owner:admin-pw@${NEON_HOST}/neondb?sslmode=require&channel_binding=require`;
  const neonIn = (stack: string, args: Extra = {}, adminUrl = NEON_URL) =>
    databaseIn(stack, { flavor: 'neon', ...args }, 'basefresh', adminUrl);

  test('the admin username is the role as given, with no .<branch> split, on the direct host', async () => {
    const { resources } = await neonIn('staging');
    const provider = resources.find((r) => r.type === 'pulumi:providers:postgresql')!;
    expect(provider.inputs).toMatchObject({
      host: NEON_HOST,
      port: '5432',
      username: 'site.owner',
      databaseUsername: 'site.owner',
      database: 'neondb',
      sslmode: 'verify-full',
      superuser: 'false',
    });
    expect(one(resources, 'db-admin-member').inputs).toEqual({ role: 'site.owner', grantRole: 'basefresh_stg_owner' });
  });

  test.each(['pr-7', 'staging', 'prod'])(
    '%s grants no owner role to pebble_operators; the rest keeps its names',
    async (stack) => {
      const { resources } = await neonIn(stack);
      const planetscale = children((await databaseIn(stack)).resources);
      expect(children(resources)).toEqual(planetscale.filter((line) => !line.endsWith(' db-operators')));
      expect(resources.filter((r) => r.inputs.role === OPERATORS_GROUP)).toEqual([]);
    }
  );

  test('the URLs log in as the role names, the pooled one on the -pooler host, port 5432, channel binding kept', async () => {
    const { result } = await neonIn('staging');
    const direct = new URL(result.directUrl);
    const pooled = new URL(result.pooledUrl!);
    expect([direct.username, direct.hostname, direct.port, direct.pathname]).toEqual([
      'basefresh_stg_owner',
      NEON_HOST,
      '5432',
      '/basefresh_stg',
    ]);
    expect([pooled.username, pooled.password, pooled.hostname, pooled.port, pooled.pathname]).toEqual([
      'basefresh_stg_runtime',
      'mock-password-db-runtime-password',
      'ep-cool-123-pooler.ap-southeast-1.aws.neon.tech',
      '5432',
      '/basefresh_stg',
    ]);
    for (const url of [direct, pooled]) {
      expect([url.searchParams.get('sslmode'), url.searchParams.get('channel_binding')]).toEqual([
        'verify-full',
        'require',
      ]);
    }
    expect(result.secret).toEqual([true, true]);
  });

  test('pooler host and port override the derived ones, with the role name unsplit', async () => {
    const { result } = await neonIn('staging', { pooler: { host: 'pool.example.com', port: 6543 } });
    const pooled = new URL(result.pooledUrl!);
    expect([pooled.username, pooled.hostname, pooled.port]).toEqual([
      'basefresh_stg_runtime',
      'pool.example.com',
      '6543',
    ]);
  });

  test('a preview is the owner-only database on its own admin URL, with no pooled URL', async () => {
    const { result, resources } = await neonIn('pr-7');
    expect(one(resources, 'db').inputs).toMatchObject({ name: 'basefresh_pr_7', owner: 'basefresh_pr_7' });
    expect(new URL(result.directUrl).username).toBe('basefresh_pr_7');
    expect(result.pooledUrl).toBeUndefined();
  });

  test('refuses a pooled admin host: DDL goes to the direct endpoint', async () => {
    const pooledAdmin = NEON_URL.replace('ep-cool-123.', 'ep-cool-123-pooler.');
    // The URL is a secret Input, so the refusal comes from inside an apply and fails the run.
    const program = () =>
      runProgram({ project: 'basefresh', stack: 'staging' }, () => {
        const stage = new Stage('stage', { product: 'basefresh' });
        new Database('db', { stage, adminUrl: pulumi.secret(pooledAdmin), flavor: 'neon' });
      });
    await expect(program()).rejects.toThrow('the Neon admin URL must use the direct host, not the pooled one');
  });

  test.each(['EP-COOL-123-POOLER', 'ep-cool-123-Pooler'])(
    'refuses a pooled admin host in any case: %s',
    async (label) => {
      const pooledAdmin = NEON_URL.replace('ep-cool-123.', `${label}.`);
      const program = () =>
        runProgram({ project: 'basefresh', stack: 'staging' }, () => {
          const stage = new Stage('stage', { product: 'basefresh' });
          new Database('db', { stage, adminUrl: pulumi.secret(pooledAdmin), flavor: 'neon' });
        });
      await expect(program()).rejects.toThrow('the Neon admin URL must use the direct host, not the pooled one');
    }
  );

  test('an upper-case direct host gets the lower-case -pooler host', async () => {
    const { result } = await neonIn('staging', {}, NEON_URL.replace('ep-cool-123.', 'EP-COOL-123.'));
    expect(new URL(result.pooledUrl!).hostname).toBe('ep-cool-123-pooler.ap-southeast-1.aws.neon.tech');
  });

  test('refuses an unknown flavor', async () => {
    await expect(databaseIn('staging', { flavor: 'supabase' } as never)).rejects.toThrow(
      'flavor "supabase" must be one of planetscale, neon'
    );
  });
});
