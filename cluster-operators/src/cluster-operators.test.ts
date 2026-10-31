import { runProgram } from '@pebbletech/infra/testing';
import { describe, expect, test } from 'vitest';

import { adminUrlFrom, clusterOperators, settings } from './cluster-operators.js';

const ROLE = 'pscale_api_c';

describe('stack settings', () => {
  test('one stack per cluster: pebble-stg and pebble-prd-shared', () => {
    expect(
      ['pebble-stg', 'pebble-prd-shared'].map(
        (stack) => settings(stack, { adminRole: ROLE, members: ['pscale_api_a'] }).cluster
      )
    ).toEqual(['pebble-stg', 'pebble-prd-shared']);
    expect(() => settings('shared', { adminRole: ROLE, members: [] })).toThrow(
      'pebble-cluster-operators stacks are pebble-stg and pebble-prd-shared, one per cluster (got "shared")'
    );
  });

  test('adoptExisting is off unless set, and must be a boolean', () => {
    expect(settings('pebble-stg', { adminRole: ROLE, members: [] }).adoptExisting).toBe(false);
    expect(settings('pebble-stg', { adminRole: ROLE, members: [], adoptExisting: true }).adoptExisting).toBe(true);
    expect(() => settings('pebble-stg', { adminRole: ROLE, members: [], adoptExisting: 'true' })).toThrow(
      'adoptExisting must be true or false'
    );
  });

  test.each([undefined, 'pscale_api_a', [1], {}])(
    'members is required, as a list of names, even when empty: %j',
    (members) => {
      expect(() => settings('pebble-stg', { adminRole: ROLE, members })).toThrow(
        'members must be a list of role names'
      );
    }
  );

  test.each([undefined, '', 'pscale_api_c.main'])('adminRole is required, without a branch suffix: %j', (adminRole) => {
    expect(() => settings('pebble-stg', { members: [], adminRole })).toThrow(
      "adminRole must be this cluster's cluster admin role, without a .<branch> suffix"
    );
  });

  test('an empty list is allowed when given', () => {
    expect(settings('pebble-stg', { adminRole: ROLE, members: [] }).members).toEqual([]);
  });
});

describe('the cluster admin URL', () => {
  test('comes from CLUSTER_ADMIN_URL, never stack config', () => {
    expect(adminUrlFrom({ CLUSTER_ADMIN_URL: 'postgresql://c:pw@host:5432/postgres' })).toBe(
      'postgresql://c:pw@host:5432/postgres'
    );
    expect(() => adminUrlFrom({ PG_ADMIN_URL: 'postgresql://a:pw@host:5432/postgres' })).toThrow(
      "CLUSTER_ADMIN_URL is unset: export the cluster admin's URL"
    );
  });
});

describe('the wrong cluster', () => {
  test("a URL for another role than this stack's cluster admin is refused before any connection", async () => {
    // The host does not resolve: a connection attempt would fail with a DNS error, not this refusal.
    const program = runProgram({ project: 'pebble-cluster-operators', stack: 'pebble-stg' }, () =>
      clusterOperators({
        cluster: 'pebble-stg',
        adoptExisting: false,
        members: [],
        adminRole: ROLE,
        adminUrl: 'postgresql://pscale_api_other.main:pw@other-cluster.invalid:5432/postgres',
      })
    );
    await expect(program).rejects.toThrow(
      `CLUSTER_ADMIN_URL is for role "pscale_api_other", not this stack's cluster admin "${ROLE}"`
    );
  });
});
