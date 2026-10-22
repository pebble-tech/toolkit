import { runProgram } from '@pebbletech/infra/testing';
import { describe, expect, test } from 'vitest';

import { bootstrap } from './bootstrap.js';

const run = (env: 'preview' | 'staging' | 'prod') =>
  runProgram({ project: 'basefresh-bootstrap', stack: env }, () =>
    bootstrap({
      env,
      oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
      stateBucket: 'pebble-stg-pulumi-state',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/abc',
    })
  );

describe('basefresh bootstrap', () => {
  test.each(['preview', 'staging', 'prod'] as const)('%s creates its deploy role, policy and boundary', async (env) => {
    const { resources } = await run(env);
    expect(resources.map((r) => `${r.type} ${r.inputs.name ?? r.name}`).sort()).toEqual([
      'aws:iam/policy:Policy basefresh-' + env + '-boundary',
      'aws:iam/role:Role basefresh-' + env + '-deploy',
      'aws:iam/rolePolicy:RolePolicy deploy',
      'pebbletech:index:DeployRole deploy',
    ]);
  });

  test('staging may also write the shared stack state', async () => {
    const { resources } = await run('staging');
    const policy = JSON.parse(resources.find((r) => r.type === 'aws:iam/rolePolicy:RolePolicy')!.inputs.policy);
    expect(policy.Statement.find((s: { Sid: string }) => s.Sid === 'StateObjects').Resource).toEqual([
      'arn:aws:s3:::pebble-stg-pulumi-state/basefresh/staging/*',
      'arn:aws:s3:::pebble-stg-pulumi-state/basefresh/shared/*',
    ]);
  });
});
