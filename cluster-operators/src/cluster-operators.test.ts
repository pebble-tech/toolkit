import { describe, expect, test } from 'vitest';

import { adminUrlFrom, settings } from './cluster-operators.js';

describe('stack settings', () => {
  test('one stack per cluster: pebble-stg and pebble-prd-shared', () => {
    expect(
      ['pebble-stg', 'pebble-prd-shared'].map((stack) => settings(stack, { members: ['pscale_api_a'] }).cluster)
    ).toEqual(['pebble-stg', 'pebble-prd-shared']);
    expect(() => settings('shared', { members: [] })).toThrow(
      'pebble-cluster-operators stacks are pebble-stg and pebble-prd-shared, one per cluster (got "shared")'
    );
  });

  test('adoptExisting is off unless set, and must be a boolean', () => {
    expect(settings('pebble-stg', { members: [] }).adoptExisting).toBe(false);
    expect(settings('pebble-stg', { members: [], adoptExisting: true }).adoptExisting).toBe(true);
    expect(() => settings('pebble-stg', { members: [], adoptExisting: 'true' })).toThrow(
      'adoptExisting must be true or false'
    );
  });

  test.each([undefined, 'pscale_api_a', [1], {}])(
    'members is required, as a list of names, even when empty: %j',
    (members) => {
      expect(() => settings('pebble-stg', { members })).toThrow('members must be a list of role names');
    }
  );

  test('an empty list is allowed when given', () => {
    expect(settings('pebble-stg', { members: [] }).members).toEqual([]);
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
