import * as aws from '@pulumi/aws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  ApiFunction,
  DeployRole,
  NamespaceError,
  OwnershipError,
  Stage,
  StageError,
  deployState,
  stateKeyAlias,
} from './index.js';
import { type Registration, runProgram } from './testing.js';

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

  test('a product id is the database name prefix', async () => {
    const { stage } = await stageIn('staging', 'foundervoice');
    expect(stage.databaseName()).toBe('foundervoice_stg');
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

  test.each(['Base', 'base_app', '-base', '', 'a', 'base-staging', 'base-pr', 'shared-tools'])(
    'refuses the malformed product id "%s"',
    (product) => {
      expect(() => new Stage('stage', { product, stack: 'staging' })).toThrow(StageError);
    }
  );

  test.each(['founder-voice', 'other-basefresh', 'basefresh-stg'])(
    'refuses a product id that is not one DNS label: %s',
    (product) => {
      expect(() => new Stage('stage', { product, stack: 'staging' })).toThrow(/one DNS label/);
    }
  );

  test.each(['dev', 'stg', 'prd', 'production', 'pr-0', 'pr-', 'pr-7a', 'preview'])('refuses the stack %s', (stack) => {
    expect(() => new Stage('stage', { product: 'basefresh', stack })).toThrow(StageError);
  });

  test('names refuse kinds that would break the namespace shape', async () => {
    const { stage } = await stageIn('staging');
    expect(() => stage.name('../x')).toThrow(NamespaceError);
    expect(() => stage.name('Api')).toThrow(NamespaceError);
    expect(() => stage.name('api-v2')).toThrow(/one DNS label/);
    expect(() => stage.hostname('api-v2', 'pebbletech.my')).toThrow(/one DNS label/);
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

/** Whether the AWS SDK's resource class for `type` (`aws:<module>/<name>:<Class>`) sends a `tags` input. */
function takesTags(type: string): boolean {
  const [, module, name] = /^aws:([^/]+)\/[^:]+:(.+)$/.exec(type)!;
  const resource = (aws as unknown as Record<string, Record<string, unknown>>)[module!]![name!];
  return String(resource).includes('resourceInputs["tags"] = args?.tags');
}

describe('cost tags', () => {
  // Cost per product is read from the `product` and `env` tags. Every component that creates AWS resources, in every
  // stack it allows, through the mocks: ApiFunction (its alarm included) and the DeployRole of each env.
  test('every AWS resource of a type that takes tags carries product and env', async () => {
    const code = mkdtempSync(join(tmpdir(), 'pebbletech-infra-tags-'));
    writeFileSync(join(code, 'index.js'), 'export const handler = async () => ({ statusCode: 200 });\n');
    const created: Registration[] = [];
    for (const stack of ['pr-7', 'staging', 'prod']) {
      const { resources } = await runProgram({ project: 'basefresh', stack }, () => {
        const stage = new Stage('stage', { product: 'basefresh' });
        new ApiFunction('api', {
          stage,
          code,
          domain: { hostname: stage.hostname('api', 'pebbletech.my'), zoneId: 'zone-1' },
          alarm: { topicArn: 'arn:aws:sns:ap-southeast-1:123456789012:alerts' },
        });
      });
      created.push(...resources);
    }
    for (const env of ['preview', 'staging', 'prod'] as const) {
      const { resources } = await runProgram(
        { project: 'basefresh-bootstrap', stack: env },
        () =>
          new DeployRole('deploy', {
            product: 'basefresh',
            env,
            apex: 'pebbletech.my',
            github: { org: 'pebble-tech', repo: 'basefresh' },
          })
      );
      created.push(...resources);
    }

    const tagged = created.filter((r) => r.type.startsWith('aws:') && takesTags(r.type));
    expect(new Set(tagged.map((r) => r.type))).toEqual(
      new Set([
        'aws:acm/certificate:Certificate',
        'aws:apigatewayv2/api:Api',
        'aws:apigatewayv2/domainName:DomainName',
        'aws:apigatewayv2/stage:Stage',
        'aws:cloudwatch/logGroup:LogGroup',
        'aws:cloudwatch/metricAlarm:MetricAlarm',
        'aws:iam/policy:Policy',
        'aws:iam/role:Role',
        'aws:lambda/function:Function',
      ])
    );
    expect(
      tagged.filter((r) => r.inputs.tags?.product !== 'basefresh' || !r.inputs.tags?.env).map((r) => r.urn)
    ).toEqual([]);
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
