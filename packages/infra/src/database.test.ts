import * as pulumi from '@pulumi/pulumi';
import { describe, expect, test } from 'vitest';

import { Database, DatabaseNameError, NamespaceError, OwnershipError, Stage } from './index.js';
import { runProgram, valueOf } from './testing.js';

const ADMIN_URL = 'postgresql://postgres.abc123:admin-pw@sin.pg.psdb.cloud:6432/postgres?sslmode=require';
const OWNER = { role: 'basefresh_app', password: 'owner-pw' };

async function databaseIn(stack: string, args: { name?: string; owner?: typeof OWNER } = {}) {
  return runProgram({ project: 'basefresh', stack }, async () => {
    const stage = new Stage('stage', { product: 'basefresh' });
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

describe('Database', () => {
  test('a preview creates its own login role, database and public revoke through an explicit admin provider', async () => {
    const { resources } = await databaseIn('pr-7');
    const children = resources.filter((r) => r.parent.endsWith('pebbletech:index:Database::db'));
    expect(children.map((r) => r.type).sort()).toEqual([
      'postgresql:index/database:Database',
      'postgresql:index/grant:Grant',
      'postgresql:index/grantRole:GrantRole',
      'postgresql:index/role:Role',
      'pulumi:providers:postgresql',
      'random:index/randomPassword:RandomPassword',
    ]);
    const byType = (type: string) => resources.find((r) => r.type === type)!;
    expect(byType('postgresql:index/database:Database').inputs).toMatchObject({
      name: 'basefresh_pr_7',
      owner: 'basefresh_pr_7',
    });
    expect(byType('postgresql:index/role:Role').inputs).toMatchObject({ name: 'basefresh_pr_7', login: true });
    expect(byType('postgresql:index/grantRole:GrantRole').inputs).toMatchObject({
      role: 'postgres',
      grantRole: 'basefresh_pr_7',
    });
    expect(byType('postgresql:index/grant:Grant').inputs).toMatchObject({
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

  test('staging takes an existing owner, creates no role, and outputs a pooled URL on 6432', async () => {
    const { result, resources } = await databaseIn('staging', { owner: OWNER });
    expect(resources.some((r) => r.type === 'postgresql:index/role:Role')).toBe(false);
    expect(resources.find((r) => r.type === 'postgresql:index/database:Database')!.inputs).toMatchObject({
      name: 'basefresh_stg',
      owner: 'basefresh_app',
    });
    const pooled = new URL(result.pooledUrl!);
    expect([pooled.username, pooled.password, pooled.port, pooled.pathname]).toEqual([
      'basefresh_app.abc123',
      'owner-pw',
      '6432',
      '/basefresh_stg',
    ]);
    expect(new URL(result.directUrl).port).toBe('5432');
  });

  test('both URLs are secret outputs, and the admin password reaches the provider as a secret', async () => {
    const { result, resources } = await databaseIn('staging', { owner: OWNER });
    expect(result.secret).toEqual([true, true]);
    expect(resources.find((r) => r.type === 'pulumi:providers:postgresql')!.secretInputs).toContain('password');
  });

  test('outputs are registered on the component, with both URLs', async () => {
    const { resources } = await databaseIn('staging', { owner: OWNER });
    const component = resources.find((r) => r.type === 'pebbletech:index:Database')!;
    expect(Object.keys(component.outputs ?? {}).sort()).toEqual([
      'databaseName',
      'directUrl',
      'ownerRole',
      'pooledUrl',
    ]);
    expect(component.outputs).toMatchObject({ databaseName: 'basefresh_stg', ownerRole: 'basefresh_app' });
  });

  test('on prod every database resource is protected and retained', async () => {
    const { resources } = await databaseIn('prod', { owner: OWNER });
    const managed = resources.filter((r) => r.custom && r.type.startsWith('postgresql:'));
    expect(managed).toHaveLength(3);
    for (const resource of managed) {
      expect([resource.type, resource.protect, resource.retainOnDelete]).toEqual([resource.type, true, true]);
    }
    expect(managed.find((r) => r.type === 'postgresql:index/database:Database')!.inputs.name).toBe('basefresh_prd');
  });

  test('outside prod nothing is protected', async () => {
    const { resources } = await databaseIn('staging', { owner: OWNER });
    expect(resources.filter((r) => r.protect || r.retainOnDelete)).toEqual([]);
  });

  test.each(['Basefresh_stg', 'basefresh-stg', '1basefresh', `basefresh_${'x'.repeat(60)}`])(
    'refuses the database name %s',
    async (name) => {
      await expect(databaseIn('staging', { name, owner: OWNER })).rejects.toThrow(DatabaseNameError);
    }
  );

  test("refuses a database outside the product's prefix", async () => {
    await expect(databaseIn('staging', { name: 'other_stg', owner: OWNER })).rejects.toThrow(NamespaceError);
  });

  test('refuses staging and prod without an existing owner role', async () => {
    await expect(databaseIn('staging')).rejects.toThrow(OwnershipError);
    await expect(databaseIn('prod')).rejects.toThrow(OwnershipError);
  });

  test('refuses the shared stack', async () => {
    await expect(databaseIn('shared', { owner: OWNER })).rejects.toThrow(OwnershipError);
  });
});
