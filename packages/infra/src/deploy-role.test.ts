import { describe, expect, test } from 'vitest';

import { DeployRole, type DeployRoleArgs, StageError } from './index.js';
import { runProgram } from './testing.js';

const OIDC = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
const KMS = 'arn:aws:kms:ap-southeast-1:123456789012:key/abc';

async function roleFor(env: DeployRoleArgs['env'], extra: Partial<DeployRoleArgs> = {}) {
  return runProgram(
    { project: 'basefresh-bootstrap', stack: env },
    () =>
      new DeployRole('deploy', {
        product: 'basefresh',
        env,
        github: { org: 'pebble-tech', repo: 'basefresh' },
        oidcProviderArn: OIDC,
        state: { bucket: 'pebble-stg-pulumi-state', kmsKeyArn: KMS },
        ...extra,
      })
  );
}

const find = (resources: { type: string }[], type: string) => resources.find((r) => r.type === type) as any;
const statement = (policy: any, sid: string) => policy.Statement.find((s: any) => s.Sid === sid);

describe('DeployRole', () => {
  test('creates the boundary policy, the role and its inline policy', async () => {
    const { resources } = await roleFor('staging');
    expect(
      resources
        .filter((r) => r.custom)
        .map((r) => `${r.type} ${r.name}`)
        .sort()
    ).toEqual([
      'aws:iam/policy:Policy deploy-boundary',
      'aws:iam/role:Role deploy-role',
      'aws:iam/rolePolicy:RolePolicy deploy-policy',
    ]);
    expect(find(resources, 'aws:iam/role:Role').inputs.name).toBe('basefresh-staging-deploy');
    expect(find(resources, 'aws:iam/policy:Policy').inputs.name).toBe('basefresh-staging-boundary');
  });

  test('trusts only GitHub OIDC tokens from the environment that matches the env', async () => {
    for (const [env, environment] of [
      ['preview', 'preview'],
      ['staging', 'staging'],
      ['prod', 'production'],
    ] as const) {
      const { resources } = await roleFor(env);
      const trust = JSON.parse(find(resources, 'aws:iam/role:Role').inputs.assumeRolePolicy);
      expect(trust.Statement).toEqual([
        {
          Effect: 'Allow',
          Principal: { Federated: OIDC },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': [`repo:pebble-tech/basefresh:environment:${environment}`],
            },
          },
        },
      ]);
    }
  });

  test('the boundary only lets workload roles write their own Lambda logs', async () => {
    const { resources } = await roleFor('staging');
    expect(JSON.parse(find(resources, 'aws:iam/policy:Policy').inputs.policy).Statement).toEqual([
      {
        Effect: 'Allow',
        Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [
          'arn:aws:logs:*:*:log-group:/aws/lambda/basefresh-staging-*',
          'arn:aws:logs:*:*:log-group:/aws/lambda/basefresh-staging-*:*',
        ],
      },
    ]);
  });

  test('roles can be created, changed and passed only inside the namespace and only with the boundary', async () => {
    const { resources } = await roleFor('staging');
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    const boundary = 'arn:aws:iam::123456789012:policy/basefresh-staging-boundary';
    expect(statement(policy, 'RolesOnlyWithBoundary')).toMatchObject({
      Action: expect.arrayContaining(['iam:CreateRole', 'iam:PutRolePolicy']),
      Resource: 'arn:aws:iam::*:role/basefresh-staging-*',
      Condition: { StringEquals: { 'iam:PermissionsBoundary': boundary } },
    });
    expect(statement(policy, 'AttachOnlyBasicExecution').Condition).toEqual({
      StringEquals: { 'iam:PermissionsBoundary': boundary },
      ArnEquals: { 'iam:PolicyARN': 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
    });
    expect(statement(policy, 'PassRolesToLambda')).toMatchObject({
      Resource: 'arn:aws:iam::*:role/basefresh-staging-*',
      Condition: {
        StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com', 'iam:PermissionsBoundary': boundary },
      },
    });
    expect(statement(policy, 'NeverTouchSelfOrBoundary')).toEqual({
      Sid: 'NeverTouchSelfOrBoundary',
      Effect: 'Deny',
      Action: 'iam:*',
      Resource: ['arn:aws:iam::*:role/basefresh-staging-deploy', 'arn:aws:iam::*:policy/basefresh-staging-boundary'],
    });
    const iamAllows = policy.Statement.filter(
      (s: any) => s.Effect === 'Allow' && [s.Action].flat().some((a: string) => a.startsWith('iam:'))
    );
    expect(iamAllows.every((s: any) => s.Resource === 'arn:aws:iam::*:role/basefresh-staging-*')).toBe(true);
  });

  test('Lambda, logs and certificates are scoped to the namespace or its tags', async () => {
    const { resources } = await roleFor('staging');
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    expect(statement(policy, 'Lambda').Resource).toBe('arn:aws:lambda:*:*:function:basefresh-staging-*');
    expect(statement(policy, 'Logs').Resource).toEqual([
      'arn:aws:logs:*:*:log-group:/aws/lambda/basefresh-staging-*',
      'arn:aws:logs:*:*:log-group:/aws/lambda/basefresh-staging-*:*',
    ]);
    expect(statement(policy, 'CertificatesCreateTagged')).toMatchObject({
      Action: ['acm:RequestCertificate', 'acm:AddTagsToCertificate'],
      Condition: { StringLike: { 'aws:RequestTag/product': 'basefresh', 'aws:RequestTag/env': 'staging' } },
    });
    expect(statement(policy, 'CertificatesChangeOwn').Condition).toEqual({
      StringLike: { 'aws:ResourceTag/product': 'basefresh', 'aws:ResourceTag/env': 'staging' },
    });
  });

  test('a preview role covers every pr-<n> stack and nothing else', async () => {
    const { resources } = await roleFor('preview');
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    expect(statement(policy, 'Lambda').Resource).toBe('arn:aws:lambda:*:*:function:basefresh-pr-*');
    expect(statement(policy, 'CertificatesChangeOwn').Condition.StringLike['aws:ResourceTag/env']).toBe('pr-*');
  });

  test('state access is limited to its paths in the bucket and its KMS key', async () => {
    const { resources } = await roleFor('staging', {
      state: {
        bucket: 'pebble-stg-pulumi-state',
        paths: ['basefresh/staging', 'basefresh/shared'],
        kmsKeyArn: KMS,
      },
    });
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    expect(statement(policy, 'StateList')).toMatchObject({
      Resource: 'arn:aws:s3:::pebble-stg-pulumi-state',
      Condition: {
        StringLike: {
          's3:prefix': ['basefresh/staging', 'basefresh/staging/*', 'basefresh/shared', 'basefresh/shared/*'],
        },
      },
    });
    expect(statement(policy, 'StateObjects').Resource).toEqual([
      'arn:aws:s3:::pebble-stg-pulumi-state/basefresh/staging/*',
      'arn:aws:s3:::pebble-stg-pulumi-state/basefresh/shared/*',
    ]);
    expect(statement(policy, 'StateSecrets').Resource).toBe(KMS);
  });

  test('no statement grants a wildcard action on a wildcard resource', async () => {
    const { resources } = await roleFor('prod');
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    const broad = policy.Statement.filter(
      (s: any) => s.Effect === 'Allow' && [s.Action].flat().some((a: string) => a === '*' || a.endsWith(':*'))
    );
    expect(broad).toEqual([]);
  });

  test('prod protects and retains the role, policy and boundary; staging does not', async () => {
    const prod = await roleFor('prod');
    expect(prod.resources.filter((r) => r.custom && (!r.protect || !r.retainOnDelete))).toEqual([]);
    const staging = await roleFor('staging');
    expect(staging.resources.filter((r) => r.protect || r.retainOnDelete)).toEqual([]);
  });

  test('outputs are registered', async () => {
    const { resources } = await roleFor('prod');
    expect(find(resources, 'pebbletech:index:DeployRole').outputs).toEqual({
      roleArn: 'arn:aws:iam::123456789012:role/basefresh-prod-deploy',
      roleName: 'basefresh-prod-deploy',
      boundaryArn: 'arn:aws:iam::123456789012:policy/basefresh-prod-boundary',
      boundaryName: 'basefresh-prod-boundary',
    });
  });

  test('refuses a pebble product', async () => {
    await expect(roleFor('staging', { product: 'pebble-tools' })).rejects.toThrow(StageError);
  });
});
