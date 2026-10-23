import { describe, expect, test } from 'vitest';

import { NamespaceError, OwnershipError, Stage, StageError, deployState, stateKeyAlias } from './index.js';
import { runProgram } from './testing.js';

const stageIn = async (stack: string, product = 'basefresh') => {
  const { result, resources } = await runProgram({ project: product, stack }, () => new Stage('stage', { product }));
  return { stage: result, resources };
};

describe('Stage', () => {
  test.each([
    ['pr-7', 'basefresh-pr-7', 'preview', 'basefresh_pr_7', 'app-basefresh-pr-7.pebbletech.my'],
    ['staging', 'basefresh-staging', 'staging', 'basefresh_stg', 'app-basefresh-stg.pebbletech.my'],
    ['prod', 'basefresh-prod', 'prod', 'basefresh_prd', 'app-basefresh.pebbletech.my'],
  ])('stack %s names %s, kind %s, database %s, host %s', async (stack, namespace, kind, database, host) => {
    const { stage } = await stageIn(stack);
    expect(stage.name()).toBe(namespace);
    expect(stage.name('api')).toBe(`${namespace}-api`);
    expect(stage.name('api', 'role')).toBe(`${namespace}-api-role`);
    expect(stage.kind).toBe(kind);
    expect(stage.databaseName()).toBe(database);
    expect(stage.hostname('app', 'pebbletech.my')).toBe(host);
  });

  test('reads the running stack name when none is given', async () => {
    const { stage } = await stageIn('staging');
    expect(stage.env).toBe('staging');
    expect([stage.isPreview, stage.isProd, stage.isShared]).toEqual([false, false, false]);
  });

  test('a product id with dashes gives an underscored database name', async () => {
    const { stage } = await stageIn('staging', 'founder-voice');
    expect(stage.databaseName()).toBe('founder_voice_stg');
  });

  test('registers itself as pebbletech:index:Stage with its namespace as an output', async () => {
    const { resources } = await stageIn('pr-7');
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      type: 'pebbletech:index:Stage',
      name: 'stage',
      outputs: { product: 'basefresh', env: 'pr-7', namespace: 'basefresh-pr-7' },
    });
  });

  test('prod and shared protect and retain; previews and staging do not', async () => {
    expect((await stageIn('prod')).stage.removalPolicy).toEqual({ protect: true, retainOnDelete: true });
    expect((await stageIn('shared')).stage.removalPolicy).toEqual({ protect: true, retainOnDelete: true });
    expect((await stageIn('staging')).stage.removalPolicy).toEqual({ protect: false, retainOnDelete: false });
    expect((await stageIn('pr-3')).stage.removalPolicy).toEqual({ protect: false, retainOnDelete: false });
  });

  test('default tags name the product and env', async () => {
    const { stage } = await stageIn('prod');
    expect(stage.tags).toEqual({ product: 'basefresh', env: 'prod', 'managed-by': 'pulumi' });
  });

  test.each(['pebble', 'pebble-stg', 'pebblefresh'])('refuses the reserved product id %s', (product) => {
    expect(() => new Stage('stage', { product, stack: 'staging' })).toThrow(StageError);
  });

  test.each(['Base', 'base_app', '-base', '', 'base-staging', 'base-pr', 'shared-tools'])(
    'refuses the malformed product id "%s"',
    (product) => {
      expect(() => new Stage('stage', { product, stack: 'staging' })).toThrow(StageError);
    }
  );

  test.each(['dev', 'stg', 'prd', 'production', 'pr-0', 'pr-', 'pr-7a', 'preview'])('refuses the stack %s', (stack) => {
    expect(() => new Stage('stage', { product: 'basefresh', stack })).toThrow(StageError);
  });

  test('names refuse kinds that would break the namespace shape', async () => {
    const { stage } = await stageIn('staging');
    expect(() => stage.name('../x')).toThrow(NamespaceError);
    expect(() => stage.name('Api')).toThrow(NamespaceError);
  });

  test('a hostname from another stage or product is refused', async () => {
    const { stage } = await stageIn('prod');
    expect(() => stage.assertOwnsHostname('app-basefresh.pebbletech.my')).not.toThrow();
    expect(() => stage.assertOwnsHostname('app-basefresh-stg.pebbletech.my')).toThrow(NamespaceError);
    expect(() => stage.assertOwnsHostname('app-other.pebbletech.my')).toThrow(NamespaceError);
    expect(() => stage.assertOwnsHostname('basefresh.pebbletech.my')).toThrow(NamespaceError);
  });

  test('shared has no hostnames or databases', async () => {
    const { stage } = await stageIn('shared');
    expect(stage.name()).toBe('basefresh-shared');
    expect(() => stage.databaseName()).toThrow(OwnershipError);
    expect(() => stage.hostname('app', 'pebbletech.my')).toThrow(OwnershipError);
  });
});

describe('state keys', () => {
  test('a shared stack uses the staging key, since the staging deploy role applies it', () => {
    expect(stateKeyAlias('shared')).toBe('alias/pebble-stg-pulumi-staging');
    expect(deployState('basefresh', 'staging')).toMatchObject({
      paths: ['basefresh/staging', 'basefresh/shared'],
      kmsAlias: stateKeyAlias('shared'),
    });
  });
});
