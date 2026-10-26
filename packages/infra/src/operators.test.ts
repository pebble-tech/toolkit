import { describe, expect, test } from 'vitest';

import { Database, Operators, OwnershipError, Stage } from './index.js';
import { type Registration, runProgram } from './testing.js';

const ADMIN_URL = 'postgresql://postgres.abc123:admin-pw@sin.pg.psdb.cloud:5432/postgres';

function operatorsIn(stack: string, members: string[]) {
  return runProgram({ project: 'basefresh', stack }, () => {
    const stage = new Stage('stage', { product: 'basefresh' });
    new Operators('operators', { stage, adminUrl: ADMIN_URL, members });
  });
}

const grants = (resources: Registration[]) =>
  resources
    .filter((r) => r.type === 'postgresql:index/grantRole:GrantRole')
    .sort((a, b) => a.name.localeCompare(b.name));

describe('Operators', () => {
  test('shared creates the pebble_operators group and one grant per member', async () => {
    const { resources } = await operatorsIn('shared', ['pscale_api_alice', 'pscale_api_bob']);
    const children = resources.filter((r) => r.parent.endsWith('pebbletech:index:Operators::operators'));
    expect(children.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      'postgresql:index/grantRole:GrantRole operators-member-pscale_api_alice',
      'postgresql:index/grantRole:GrantRole operators-member-pscale_api_bob',
      'postgresql:index/role:Role operators-group',
      'pulumi:providers:postgresql operators-admin',
    ]);
    const group = children.find((r) => r.name === 'operators-group')!;
    // ignoreChanges roles: the databases' grants to the group must survive a refresh of this stack.
    expect([group.inputs.name, group.inputs.login, group.retainOnDelete, group.ignoreChanges]).toEqual([
      'pebble_operators',
      false,
      true,
      ['roles'],
    ]);
    expect(
      grants(resources).map((r) => [r.inputs, r.protect, r.retainOnDelete, r.ignoreChanges, r.dependencies])
    ).toEqual([
      [{ role: 'pscale_api_alice', grantRole: 'pebble_operators' }, false, false, ['withAdminOption'], [group.urn]],
      [{ role: 'pscale_api_bob', grantRole: 'pebble_operators' }, false, false, ['withAdminOption'], [group.urn]],
    ]);
  });

  test('removing a member drops exactly its grant; the others keep their URNs', async () => {
    const before = grants((await operatorsIn('prod', ['pscale_api_alice', 'pscale_api_bob'])).resources);
    const after = grants((await operatorsIn('prod', ['pscale_api_bob'])).resources);
    expect(after.map((r) => r.urn)).toEqual(
      before.filter((r) => r.inputs.role !== 'pscale_api_alice').map((r) => r.urn)
    );
    expect(before.map((r) => r.inputs.role)).toEqual(['pscale_api_alice', 'pscale_api_bob']);
  });

  test('no members still creates the group', async () => {
    const { resources } = await operatorsIn('shared', []);
    expect(resources.filter((r) => r.custom && !r.type.startsWith('pulumi:providers:')).map((r) => r.name)).toEqual([
      'operators-group',
    ]);
  });

  test.each(['pr-7', 'staging'])('refuses the %s stack: one stack per cluster owns the group', async (stack) => {
    await expect(operatorsIn(stack, ['pscale_api_alice'])).rejects.toThrow(
      `the operators group cannot be created in the ${stack} stack (allowed: shared, prod)`
    );
  });

  test.each([[''], ['  '], ['pscale_api_alice', 'pscale_api_alice']])(
    'refuses an empty or repeated member name: %j',
    async (...members) => {
      await expect(operatorsIn('shared', members)).rejects.toThrow(OwnershipError);
    }
  );

  test('refuses a PlanetScale login username with its .<branch> suffix, saying to drop it', async () => {
    await expect(operatorsIn('shared', ['pscale_api_alice', 'pscale_api_bob.main'])).rejects.toThrow(
      'operator member "pscale_api_bob.main" is a login username, not a role: drop the ".main" suffix and list "pscale_api_bob"'
    );
  });

  test('a bare role name is granted as given', async () => {
    const { resources } = await operatorsIn('shared', ['pscale_api_44lpekcp7tl0']);
    expect(grants(resources).map((r) => r.inputs)).toEqual([
      { role: 'pscale_api_44lpekcp7tl0', grantRole: 'pebble_operators' },
    ]);
  });

  test('in a stack with both, the group is registered once and the database grant waits for it', async () => {
    const { resources } = await runProgram({ project: 'basefresh', stack: 'prod' }, () => {
      const stage = new Stage('stage', { product: 'basefresh' });
      new Operators('operators', { stage, adminUrl: ADMIN_URL, members: ['pscale_api_alice'] });
      new Database('db', { stage, adminUrl: ADMIN_URL, runtime: { role: 'basefresh_app', password: 'pw' } });
    });
    const roles = resources.filter(
      (r) => r.type === 'postgresql:index/role:Role' && r.inputs.name === 'pebble_operators'
    );
    expect(roles.map((r) => r.name)).toEqual(['operators-group']);
    expect(grants(resources).find((r) => r.name === 'db-operators')!.dependencies).toContain(roles[0]!.urn);
  });

  test('refuses a second Operators in one program, naming the first', async () => {
    const program = runProgram({ project: 'basefresh', stack: 'prod' }, () => {
      const stage = new Stage('stage', { product: 'basefresh' });
      new Operators('operators', { stage, adminUrl: ADMIN_URL, members: ['pscale_api_alice', 'pscale_api_bob'] });
      new Operators('more', { stage, adminUrl: ADMIN_URL, members: ['pscale_api_bob'] });
    });
    await expect(program).rejects.toThrow(
      'one Operators per program: "operators" already manages pebble_operators, so "more" cannot'
    );
  });
});
