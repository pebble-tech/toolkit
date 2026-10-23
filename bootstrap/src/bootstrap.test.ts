import { DeployRole, type DeployEnv } from '@pebbletech/infra';
import { defaultMocks, runProgram, valueOf, type Registration } from '@pebbletech/infra/testing';
import type * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import { bootstrap, settings, type BootstrapSettings } from './bootstrap.js';

const ACCOUNT_ID = '123456789012';
const REGION = 'ap-southeast-1';
const OIDC_ARN = `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`;

/**
 * defaultMocks plus the ids and ARNs AWS returns for the bootstrap's resources, a log of KMS alias lookups, and the
 * provider reference each AWS resource was registered with.
 */
function mocks(aliasLookups: string[] = [], providers = new Map<string, string>()): pulumi.runtime.Mocks {
  return {
    newResource(args) {
      if (args.type.startsWith('aws:')) providers.set(`${args.type} ${args.name}`, args.provider ?? '');
      const { id, state } = defaultMocks.newResource(args) as { id: string; state: Record<string, unknown> };
      switch (args.type) {
        case 'aws:s3/bucket:Bucket':
          return { id: args.inputs.bucket, state: { ...state, arn: `arn:aws:s3:::${args.inputs.bucket}` } };
        case 'aws:kms/key:Key':
          return { id, state: { ...state, keyId: id, arn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/${id}` } };
        case 'aws:kms/alias:Alias':
          return { id, state: { ...state, arn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:${args.inputs.name}` } };
        case 'aws:iam/openIdConnectProvider:OpenIdConnectProvider':
          return { id: args.id || OIDC_ARN, state: { ...state, arn: args.id || OIDC_ARN } };
        default:
          return { id, state };
      }
    },
    call(args) {
      if (args.token === 'aws:kms/getAlias:getAlias') aliasLookups.push(String(args.inputs.name));
      return defaultMocks.call(args);
    },
  };
}

const stg: BootstrapSettings = { account: 'stg', accountId: ACCOUNT_ID, region: REGION, importOidcProvider: true };
const prd: BootstrapSettings = { ...stg, account: 'prd' };

const run = (args: BootstrapSettings, providers?: Map<string, string>) =>
  runProgram({ project: 'pebble-aws-bootstrap', stack: args.account, mocks: mocks([], providers) }, () =>
    bootstrap(args)
  );

/** The name AWS knows a resource by, or its logical name for resources that have none. */
const physical = (r: Registration): string => String(r.inputs.bucket ?? r.inputs.name ?? r.inputs.url ?? r.name);
const ofType = (resources: Registration[], type: string) => resources.filter((r) => r.type === type);
const aliases = (resources: Registration[]) =>
  ofType(resources, 'aws:kms/alias:Alias')
    .map(physical)
    .filter((name) => !name.endsWith('-state'))
    .sort();

describe('pebble-aws-bootstrap', () => {
  test('stg creates the OIDC provider, the state bucket and the preview and staging keys', async () => {
    const { resources } = await run(stg);
    expect(resources.map((r) => `${r.type} ${physical(r)}`).sort()).toEqual([
      'aws:iam/openIdConnectProvider:OpenIdConnectProvider https://token.actions.githubusercontent.com',
      'aws:kms/alias:Alias alias/pebble-stg-pulumi-preview',
      'aws:kms/alias:Alias alias/pebble-stg-pulumi-staging',
      'aws:kms/alias:Alias alias/pebble-stg-pulumi-state',
      'aws:kms/key:Key state-key',
      'aws:kms/key:Key state-preview-key',
      'aws:kms/key:Key state-staging-key',
      'aws:s3/bucket:Bucket pebble-stg-pulumi-state',
      'aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration pebble-stg-pulumi-state',
      'aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock pebble-stg-pulumi-state',
      'aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration pebble-stg-pulumi-state',
      'aws:s3/bucketVersioning:BucketVersioning pebble-stg-pulumi-state',
      'pebbletech:bootstrap:PulumiStateBucket state',
      'pebbletech:bootstrap:PulumiStateKey state-preview',
      'pebbletech:bootstrap:PulumiStateKey state-staging',
      'pulumi:providers:aws aws',
    ]);
  });

  test('prd creates the OIDC provider, the state bucket and the prod key only', async () => {
    const { resources } = await run(prd);
    expect(resources.map((r) => `${r.type} ${physical(r)}`).sort()).toEqual([
      'aws:iam/openIdConnectProvider:OpenIdConnectProvider https://token.actions.githubusercontent.com',
      'aws:kms/alias:Alias alias/pebble-prd-pulumi-prod',
      'aws:kms/alias:Alias alias/pebble-prd-pulumi-state',
      'aws:kms/key:Key state-key',
      'aws:kms/key:Key state-prod-key',
      'aws:s3/bucket:Bucket pebble-prd-pulumi-state',
      'aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration pebble-prd-pulumi-state',
      'aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock pebble-prd-pulumi-state',
      'aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration pebble-prd-pulumi-state',
      'aws:s3/bucketVersioning:BucketVersioning pebble-prd-pulumi-state',
      'pebbletech:bootstrap:PulumiStateBucket state',
      'pebbletech:bootstrap:PulumiStateKey state-prod',
      'pulumi:providers:aws aws',
    ]);
  });

  test.each([stg, prd])('$account protects and retains every cloud resource', async (args) => {
    const { resources } = await run(args);
    const cloud = resources.filter((r) => r.custom && !r.type.startsWith('pulumi:providers:'));
    expect(cloud.filter((r) => !r.protect || !r.retainOnDelete).map((r) => r.urn)).toEqual([]);
  });

  test('every AWS resource goes through a provider that refuses any account but the configured one', async () => {
    const providers = new Map<string, string>();
    const { resources } = await run(stg, providers);
    const pinned = ofType(resources, 'pulumi:providers:aws')[0]!;
    expect(pinned.inputs).toMatchObject({ region: REGION, allowedAccountIds: JSON.stringify([ACCOUNT_ID]) });
    expect(providers.size).toBe(resources.filter((r) => r.type.startsWith('aws:')).length);
    expect([...providers.values()].filter((ref) => !ref.startsWith(`${pinned.urn}::`))).toEqual([]);
  });

  test('the state bucket is versioned, private, SSE-KMS under its own key, and expires superseded state after 30 days', async () => {
    const { resources } = await run(stg);
    const only = (type: string) => ofType(resources, `aws:s3/${type}`)[0]!.inputs;
    const bucketKey = `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/state-key-id`;

    expect(only('bucketVersioning:BucketVersioning')).toMatchObject({
      bucket: 'pebble-stg-pulumi-state',
      versioningConfiguration: { status: 'Enabled' },
    });
    expect(only('bucketPublicAccessBlock:BucketPublicAccessBlock')).toMatchObject({
      bucket: 'pebble-stg-pulumi-state',
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(only('bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration')).toMatchObject({
      bucket: 'pebble-stg-pulumi-state',
      rules: [
        {
          applyServerSideEncryptionByDefault: { sseAlgorithm: 'aws:kms', kmsMasterKeyId: bucketKey },
          bucketKeyEnabled: true,
        },
      ],
    });
    expect(only('bucketLifecycleConfiguration:BucketLifecycleConfiguration')).toMatchObject({
      bucket: 'pebble-stg-pulumi-state',
      rules: [{ status: 'Enabled', noncurrentVersionExpiration: { noncurrentDays: 30 } }],
    });
  });

  test('deploy roles reach the bucket key only through S3; the state keys are left to IAM', async () => {
    const { resources } = await run(stg);
    const policies = Object.fromEntries(
      ofType(resources, 'aws:kms/key:Key').map((r) => [r.name, JSON.parse(r.inputs.policy).Statement])
    );
    const admin = {
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${ACCOUNT_ID}:root` },
      Action: 'kms:*',
      Resource: '*',
    };
    expect(policies['state-key']).toMatchObject([
      admin,
      {
        Principal: { AWS: '*' },
        Condition: {
          StringEquals: { 'kms:CallerAccount': ACCOUNT_ID, 'kms:ViaService': `s3.${REGION}.amazonaws.com` },
        },
      },
    ]);
    expect(policies['state-preview-key']).toEqual([{ Sid: 'AccountIamManagesKey', ...admin }]);
  });

  test('every name is a pebble- name or the GitHub issuer: nothing belongs to a product', async () => {
    const { resources } = await run(stg);
    const named = resources.filter((r) => r.inputs.bucket !== undefined || r.inputs.name !== undefined);
    expect(named.map(physical).filter((name) => !/^(alias\/)?pebble-/.test(name))).toEqual([]);
  });

  test('outputs the provider ARN, bucket name and alias ARNs', async () => {
    const { result } = await run(prd);
    expect(await valueOf(result.oidcProviderArn)).toBe(OIDC_ARN);
    expect(result.stateBucket).toBe('pebble-prd-pulumi-state');
    expect(await resolveAll(result.keyAliasArns)).toEqual({
      prod: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:alias/pebble-prd-pulumi-prod`,
    });
  });
});

describe('the OIDC provider', () => {
  /** What a committed stack file sets, read the way the entry point reads stack config. */
  const committed = (stack: 'stg' | 'prd') => {
    const config = parse(readFileSync(new URL(`../Pulumi.${stack}.yaml`, import.meta.url), 'utf8')).config;
    return settings(stack, {
      accountId: ACCOUNT_ID,
      region: config['aws:region'],
      oidc: config['pebble-aws-bootstrap:oidc'],
    });
  };

  // README step 5 turns oidc.import off once the provider is adopted, and step 8 commits that: both states are valid.
  test.each(['stg', 'prd'] as const)(
    'the committed %s stack imports the provider exactly when its oidc.import flag is on',
    async (stack) => {
      const args = committed(stack);
      const { resources } = await run(args);
      const provider = ofType(resources, 'aws:iam/openIdConnectProvider:OpenIdConnectProvider')[0]!;
      expect(provider.importId).toBe(args.importOidcProvider ? OIDC_ARN : '');
      expect(provider.inputs).toMatchObject({
        url: 'https://token.actions.githubusercontent.com',
        clientIdLists: ['sts.amazonaws.com'],
        thumbprintLists: ['6938fd4d98bab03faadb97b34396831e3780aea1', '1c58a3a8518e8759bf075b76b750d4f2df264fcd'],
      });
    }
  );

  test('with the flag the existing provider is adopted by its ARN', async () => {
    const { resources } = await run({ ...stg, importOidcProvider: true });
    expect(ofType(resources, 'aws:iam/openIdConnectProvider:OpenIdConnectProvider')[0]!.importId).toBe(OIDC_ARN);
  });

  test.each(['stg', 'prd'] as const)('the committed %s stack file holds the account id only encrypted', (stack) => {
    const config = parse(readFileSync(new URL(`../Pulumi.${stack}.yaml`, import.meta.url), 'utf8')).config;
    const accountId = config['pebble-aws-bootstrap:accountId'] ?? { secure: 'not set yet' };
    expect(accountId).toEqual({ secure: expect.any(String) });
  });

  test('without the flag the provider is created, not imported', async () => {
    const { resources } = await run({ ...stg, importOidcProvider: false });
    expect(ofType(resources, 'aws:iam/openIdConnectProvider:OpenIdConnectProvider')[0]!.importId).toBe('');
  });

  test('the provider DeployRole trusts is the one the bootstrap adopts', async () => {
    const { resources } = await runProgram({ project: 'p', stack: 'staging', mocks: mocks() }, () => {
      new DeployRole('deploy', {
        product: 'anyproduct',
        env: 'staging',
        apex: 'pebbletech.my',
        github: { org: 'o', repo: 'r' },
      });
    });
    const role = ofType(resources, 'aws:iam/role:Role')[0]!;
    expect(JSON.parse(role.inputs.assumeRolePolicy).Statement[0].Principal.Federated).toBe(OIDC_ARN);
  });
});

describe('names shared with DeployRole', () => {
  /** The KMS alias and state bucket a product's DeployRole for `env` uses, observed from what it registers. */
  async function deployRoleNames(env: DeployEnv) {
    const lookups: string[] = [];
    const { resources } = await runProgram({ project: 'p', stack: env, mocks: mocks(lookups) }, () => {
      new DeployRole('deploy', { product: 'anyproduct', env, apex: 'pebbletech.my', github: { org: 'o', repo: 'r' } });
    });
    const policy = JSON.parse(ofType(resources, 'aws:iam/rolePolicy:RolePolicy')[0]!.inputs.policy);
    const bucketArn: string = policy.Statement.find((s: { Sid: string }) => s.Sid === 'StateList').Resource;
    return { aliases: lookups, bucket: bucketArn.replace('arn:aws:s3:::', '') };
  }

  // The account each deploy env runs in (contract: previews and staging in pbt-stg, prod in pbt-prd).
  test.each([
    { account: 'stg', envs: ['preview', 'staging'] },
    { account: 'prd', envs: ['prod'] },
  ] as const)('$account has exactly the aliases and bucket its deploy roles use', async ({ account, envs }) => {
    // One run at a time: the Pulumi runtime is global to the process.
    const derived = [];
    for (const env of envs) derived.push(await deployRoleNames(env));
    const { resources } = await run(account === 'stg' ? stg : prd);

    expect(aliases(resources)).toEqual(derived.flatMap((d) => d.aliases).sort());
    expect(new Set(derived.map((d) => d.bucket))).toEqual(
      new Set(ofType(resources, 'aws:s3/bucket:Bucket').map(physical))
    );
  });
});

describe('stack settings', () => {
  test('only stg and prd stacks run', () => {
    expect(() => settings('dev', { accountId: ACCOUNT_ID, region: REGION })).toThrow(/stg and prd/);
  });

  test('the account id must be 12 digits', () => {
    expect(() => settings('stg', { accountId: '12345', region: REGION })).toThrow(/12-digit/);
  });

  test('oidc.import must be a boolean, and is off when unset', () => {
    expect(() => settings('stg', { accountId: ACCOUNT_ID, region: REGION, oidc: { import: 'yes' } })).toThrow(
      /true or false/
    );
    expect(settings('prd', { accountId: ACCOUNT_ID, region: REGION }).importOidcProvider).toBe(false);
  });
});

async function resolveAll(record: Record<string, pulumi.Output<string>>): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(Object.entries(record).map(async ([key, value]) => [key, await valueOf(value)] as const))
  );
}
