import { describe, expect, test } from 'vitest';

import { DeployRole, type DeployRoleArgs, Stage, StageError } from './index.js';
import { runProgram } from './testing.js';

const OIDC = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';

async function roleFor(env: DeployRoleArgs['env'], extra: Partial<DeployRoleArgs> = {}) {
  return runProgram(
    { project: 'basefresh-bootstrap', stack: env },
    () =>
      new DeployRole('deploy', {
        product: 'basefresh',
        env,
        github: { org: 'pebble-tech', repo: 'basefresh' },
        ...extra,
      })
  );
}

const find = (resources: { type: string }[], type: string) => resources.find((r) => r.type === type) as any;
const statement = (policy: any, sid: string) => policy.Statement.find((s: any) => s.Sid === sid);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const gatewayArn = (path: string) => `arn:aws:apigateway:ap-southeast-1::${path}`;

function iamMatches(pattern: string, value: string): boolean {
  return new RegExp(
    '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$'
  ).test(value);
}

/** StringLike / StringLikeIfExists against the policy document. Not the IAM simulator. */
function allows(policy: { Statement: any[] }, action: string, resource: string, context: Record<string, string> = {}) {
  const matching = policy.Statement.filter(
    (s) =>
      asList(s.Action).some((item) => iamMatches(String(item), action)) &&
      asList(s.Resource).some((item) => iamMatches(String(item), resource)) &&
      Object.entries(s.Condition ?? {}).every(([op, entries]) => {
        if (op !== 'StringLike' && op !== 'StringLikeIfExists') throw new Error(`unsupported operator ${op}`);
        return Object.entries(entries as Record<string, string>).every(([key, value]) =>
          context[key] === undefined
            ? op.endsWith('IfExists')
            : asList(value).some((pattern) => iamMatches(String(pattern), context[key]!))
        );
      })
  );
  return matching.some((s) => s.Effect === 'Allow') && !matching.some((s) => s.Effect === 'Deny');
}

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

  test('roles are created and changed only with the boundary; PassRole is gated on the service alone', async () => {
    const { resources } = await roleFor('staging');
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    const boundary = 'arn:aws:iam::123456789012:policy/basefresh-staging-boundary';
    const glob = 'arn:aws:iam::*:role/basefresh-staging-*';
    expect(statement(policy, 'RolesOnlyWithBoundary')).toMatchObject({
      Action: expect.arrayContaining(['iam:CreateRole', 'iam:PutRolePolicy', 'iam:PutRolePermissionsBoundary']),
      Resource: glob,
      Condition: { StringEquals: { 'iam:PermissionsBoundary': boundary } },
    });
    expect(statement(policy, 'AttachOnlyBasicExecution')).toMatchObject({
      Action: 'iam:AttachRolePolicy',
      Resource: glob,
      Condition: {
        StringEquals: { 'iam:PermissionsBoundary': boundary },
        ArnEquals: { 'iam:PolicyARN': 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
      },
    });
    // iam:PermissionsBoundary is not in PassRole's request context; a condition on it would deny every Lambda deploy.
    expect(statement(policy, 'PassRolesToLambda')).toEqual({
      Sid: 'PassRolesToLambda',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: glob,
      Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
    });
    expect(statement(policy, 'NeverDropBoundary')).toEqual({
      Sid: 'NeverDropBoundary',
      Effect: 'Deny',
      Action: 'iam:DeleteRolePermissionsBoundary',
      Resource: '*',
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

  test('a preview role allows only its state bucket and KMS key, and still publishes the boundary', async () => {
    const { resources } = await roleFor('preview');
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    expect(policy.Statement.map((s: { Sid: string }) => s.Sid)).toEqual(['StateList', 'StateObjects', 'StateSecrets']);
    expect(find(resources, 'aws:iam/policy:Policy').inputs.name).toBe('basefresh-preview-boundary');
    expect(find(resources, 'pebbletech:index:DeployRole').outputs.boundaryArn).toBe(
      'arn:aws:iam::123456789012:policy/basefresh-preview-boundary'
    );
    expect(find(resources, 'pebbletech:index:DeployRole').outputs.roleArn).toBe(
      'arn:aws:iam::123456789012:role/basefresh-preview-deploy'
    );
  });

  test.each([
    ['staging', 'basefresh-staging-*', 'arn:aws:apigateway:*::/domainnames/*-basefresh-stg.*'],
    ['prod', 'basefresh-prod-*', 'arn:aws:apigateway:*::/domainnames/*-basefresh.*'],
  ] as const)(
    '%s creates an HTTP API only under its name, and reads domains only under its hostname',
    async (env, apiName, domainArn) => {
      const { resources } = await roleFor(env);
      const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
      const verbs = [
        'apigateway:GET',
        'apigateway:POST',
        'apigateway:PUT',
        'apigateway:PATCH',
        'apigateway:DELETE',
        'apigateway:TagResource',
        'apigateway:UntagResource',
      ];
      expect(statement(policy, 'HttpApiCreate')).toEqual({
        Sid: 'HttpApiCreate',
        Effect: 'Allow',
        Action: 'apigateway:POST',
        Resource: 'arn:aws:apigateway:*::/apis',
        Condition: { StringLike: { 'apigateway:Request/ApiName': apiName } },
      });
      expect(statement(policy, 'HttpApi')).toEqual({
        Sid: 'HttpApi',
        Effect: 'Allow',
        Action: verbs,
        Resource: 'arn:aws:apigateway:*::/apis/*',
        Condition: {
          StringLikeIfExists: {
            'apigateway:Resource/ApiName': apiName,
            'apigateway:Request/ApiName': apiName,
          },
        },
      });
      expect(statement(policy, 'HttpApiDomainCreate')).toEqual({
        Sid: 'HttpApiDomainCreate',
        Effect: 'Allow',
        Action: 'apigateway:POST',
        Resource: 'arn:aws:apigateway:*::/domainnames',
      });
      expect(statement(policy, 'HttpApiDomain')).toEqual({
        Sid: 'HttpApiDomain',
        Effect: 'Allow',
        Action: ['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'],
        Resource: domainArn,
      });
      expect(statement(policy, 'HttpApiTags')).toBeUndefined();
    }
  );

  test.each(['staging', 'prod'] as const)('rename-refusal: %s cannot rename its API to other-prod-api', async (env) => {
    const { resources } = await roleFor(env);
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    const own = { 'apigateway:Resource/ApiName': `basefresh-${env}-api` };
    expect(
      allows(policy, 'apigateway:PATCH', gatewayArn('/apis/own-id'), {
        ...own,
        'apigateway:Request/ApiName': 'other-prod-api',
      })
    ).toBe(false);
    expect(allows(policy, 'apigateway:PATCH', gatewayArn('/apis/own-id'), own)).toBe(true);
    expect(
      allows(policy, 'apigateway:PATCH', gatewayArn('/apis/own-id'), {
        ...own,
        'apigateway:Request/ApiName': `basefresh-${env}-renamed`,
      })
    ).toBe(true);
  });

  test.each(['staging', 'prod'] as const)('%s cannot tag or untag through /tags', async (env) => {
    const { resources } = await roleFor(env);
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    const tags = gatewayArn('/tags/' + encodeURIComponent(gatewayArn('/apis/foreign-id')));
    expect([allows(policy, 'apigateway:POST', tags), allows(policy, 'apigateway:DELETE', tags)]).toEqual([
      false,
      false,
    ]);
  });

  test('hostname globs match only the product and env that produced them', async () => {
    const products = ['basefresh', 'basefreshstg', 'otherbasefresh'] as const;
    const kinds = ['api', 'uploads', 'app'] as const;
    const stacks = ['pr-7', 'staging', 'prod'] as const;
    const hostnames: { product: string; stack: string; host: string }[] = [];
    for (const product of products) {
      for (const stack of stacks) {
        const { result } = await runProgram({ project: product, stack }, () => {
          const stage = new Stage('stage', { product });
          return kinds.map((kind) => stage.hostname(kind, 'pebbletech.my'));
        });
        for (const host of result) hostnames.push({ product, stack, host });
      }
    }
    for (const product of products) {
      for (const env of ['staging', 'prod'] as const) {
        const { resources } = await roleFor(env, { product });
        const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
        const glob = statement(policy, 'HttpApiDomain').Resource as string;
        const matched = hostnames.filter((row) => iamMatches(glob, gatewayArn(`/domainnames/${row.host}`)));
        const own = hostnames.filter((row) => row.product === product && row.stack === env);
        expect(own).toHaveLength(kinds.length);
        expect(matched.map((row) => row.host).sort()).toEqual(own.map((row) => row.host).sort());
      }
    }
  });

  test.each([
    ['preview', 'preview', 'pebble-stg-pulumi-state', ['basefresh/preview'], 'pebble-stg-pulumi-preview'],
    [
      'staging',
      'staging',
      'pebble-stg-pulumi-state',
      ['basefresh/staging', 'basefresh/shared'],
      'pebble-stg-pulumi-staging',
    ],
    ['prod', 'production', 'pebble-prd-pulumi-state', ['basefresh/prod'], 'pebble-prd-pulumi-prod'],
  ] as const)(
    '%s derives its GitHub environment, state bucket, paths and KMS key from the env',
    async (env, environment, bucket, paths, keyAlias) => {
      const { resources } = await roleFor(env);
      const trust = JSON.parse(find(resources, 'aws:iam/role:Role').inputs.assumeRolePolicy).Statement[0];
      const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
      expect({
        federated: trust.Principal.Federated,
        subs: trust.Condition.StringEquals['token.actions.githubusercontent.com:sub'],
        list: statement(policy, 'StateList').Resource,
        prefixes: statement(policy, 'StateList').Condition.StringLike['s3:prefix'],
        objects: statement(policy, 'StateObjects').Resource,
        key: statement(policy, 'StateSecrets').Resource,
      }).toEqual({
        federated: OIDC,
        subs: [`repo:pebble-tech/basefresh:environment:${environment}`],
        list: `arn:aws:s3:::${bucket}`,
        prefixes: paths.flatMap((path) => [path, `${path}/*`]),
        objects: paths.map((path) => `arn:aws:s3:::${bucket}/${path}/*`),
        key: `arn:aws:kms:ap-southeast-1:123456789012:key/${keyAlias}`,
      });
    }
  );

  test("a staging role cannot be given another env's trust, state paths, bucket or key (the reviewer's probe)", async () => {
    const { resources } = await roleFor('staging', {
      github: { org: 'pebble-tech', repo: 'basefresh', environments: ['preview', 'production'] },
      oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/elsewhere',
      state: {
        bucket: 'pebble-prd-pulumi-state',
        paths: ['basefresh/prod', 'basefresh/preview'],
        kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/prod',
      },
    } as never);
    const trust = JSON.parse(find(resources, 'aws:iam/role:Role').inputs.assumeRolePolicy).Statement[0];
    const policy = JSON.parse(find(resources, 'aws:iam/rolePolicy:RolePolicy').inputs.policy);
    expect([
      trust.Principal.Federated,
      trust.Condition.StringEquals['token.actions.githubusercontent.com:sub'],
      statement(policy, 'StateObjects').Resource,
      statement(policy, 'StateSecrets').Resource,
    ]).toEqual([
      OIDC,
      ['repo:pebble-tech/basefresh:environment:staging'],
      [
        'arn:aws:s3:::pebble-stg-pulumi-state/basefresh/staging/*',
        'arn:aws:s3:::pebble-stg-pulumi-state/basefresh/shared/*',
      ],
      'arn:aws:kms:ap-southeast-1:123456789012:key/pebble-stg-pulumi-staging',
    ]);
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
    await expect(roleFor('staging', { product: 'pebblefresh' })).rejects.toThrow(StageError);
  });

  test('refuses a product id that is not one DNS label', async () => {
    await expect(roleFor('staging', { product: 'other-basefresh' })).rejects.toThrow(/one DNS label/);
  });
});
