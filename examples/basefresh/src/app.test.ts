import { defaultMocks, type Registration, runProgram } from '@pebbletech/infra/testing';
import type * as pulumi from '@pulumi/pulumi';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { basefresh, type BasefreshInputs } from './app.js';
import { bootstrap } from './bootstrap.js';

const root = join(import.meta.dirname, '..');
/** The account bootstrap's `alarmTopicArn` in each account: pbt-stg for staging, pbt-prd for prod. */
const ALARM_TOPIC = {
  staging: 'arn:aws:sns:ap-southeast-1:111111111111:pebble-stg-alarms',
  prod: 'arn:aws:sns:ap-southeast-1:222222222222:pebble-prd-alarms',
};
const inputs = (stack: string): BasefreshInputs => ({
  apex: 'pebbletech.my',
  cloudflareZoneId: 'zone-1',
  cloudflareAccountId: 'account-1',
  // shared has no database, so no admin URL.
  ...(stack === 'shared' ? {} : { pgAdminUrl: 'postgresql://postgres.abc123:admin@sin.pg.psdb.cloud:5432/postgres' }),
  ...(stack.startsWith('pr-') || stack === 'shared'
    ? {}
    : { pgRuntime: { role: 'basefresh_app', password: 'runtime' } }),
  authSecret: 'auth-secret',
  ...(stack === 'staging' || stack === 'prod' ? { alarmTopicArn: ALARM_TOPIC[stack] } : {}),
  bundles: { api: join(root, 'bundles/api'), uploads: join(root, 'bundles/uploads/server.js') },
});

// What Vercel answers when staging and prod look the shared project up by name.
const mocks: pulumi.runtime.Mocks = {
  ...defaultMocks,
  call(args) {
    if (args.token === 'vercel:index/getProject:getProject') {
      const id = args.inputs.name === 'basefresh-web' ? 'prj_basefresh' : 'prj_other';
      return { ...args.inputs, id };
    }
    if (args.token === 'vercel:index/getCustomEnvironment:getCustomEnvironment') {
      const id =
        args.inputs.projectId === 'prj_basefresh' && args.inputs.name === 'staging' ? 'env_staging' : 'env_other';
      return { ...args.inputs, id };
    }
    return defaultMocks.call(args);
  },
};

const run = (stack: string) => runProgram({ project: 'basefresh', stack, mocks }, () => basefresh(inputs(stack)));

/** `type name physical-name`, one line per registered resource. */
function summary(resources: Registration[]): string[] {
  return resources
    .map((r) => {
      const i = r.inputs;
      const physical = i.name ?? i.scriptName ?? i.domainName ?? i.domain ?? i.hostname ?? i.key ?? '';
      return `${r.type} ${r.name} ${physical}`.trim();
    })
    .sort();
}

const DATABASE_STAGE = (db: string) => [
  'pebbletech:index:Database db',
  'postgresql:index/database:Database db ' + db,
  'postgresql:index/defaultPrivileges:DefaultPrivileges db-runtime-default-sequences',
  'postgresql:index/defaultPrivileges:DefaultPrivileges db-runtime-default-tables',
  'postgresql:index/grant:Grant db-revoke-public',
  'postgresql:index/grant:Grant db-runtime-connect',
  'postgresql:index/grant:Grant db-runtime-schema',
  'postgresql:index/grant:Grant db-runtime-sequences',
  'postgresql:index/grant:Grant db-runtime-tables',
  'postgresql:index/grantRole:GrantRole db-admin-member',
  'postgresql:index/grantRole:GrantRole db-operators',
  `postgresql:index/role:Role db-owner ${db}_owner`,
  'pulumi:providers:postgresql db-admin',
  'random:index/randomPassword:RandomPassword db-owner-password',
];

const RUNTIME = (env: string, suffix: string) => {
  const host = (kind: string) => `${kind}-basefresh${suffix}.pebbletech.my`;
  return [
    'aws:acm/certificate:Certificate api-certificate ' + host('api'),
    'aws:acm/certificateValidation:CertificateValidation api-certificate-validated',
    `aws:apigatewayv2/api:Api api-api basefresh-${env}-api`,
    'aws:apigatewayv2/apiMapping:ApiMapping api-mapping ' + host('api'),
    'aws:apigatewayv2/domainName:DomainName api-domain ' + host('api'),
    'aws:apigatewayv2/integration:Integration api-integration',
    'aws:apigatewayv2/route:Route api-route',
    'aws:apigatewayv2/stage:Stage api-stage $default',
    `aws:cloudwatch/logGroup:LogGroup api-logs /aws/lambda/basefresh-${env}-api`,
    `aws:cloudwatch/metricAlarm:MetricAlarm api-errors basefresh-${env}-api-errors`,
    `aws:iam/role:Role api-role basefresh-${env}-api`,
    'aws:iam/rolePolicyAttachment:RolePolicyAttachment api-basic-execution',
    `aws:lambda/function:Function api basefresh-${env}-api`,
    'aws:lambda/permission:Permission api-invoke',
    'cloudflare:index/dnsRecord:DnsRecord api-certificate-validation _validation.' + host('api'),
    'cloudflare:index/dnsRecord:DnsRecord api-cname ' + host('api'),
    'cloudflare:index/dnsRecord:DnsRecord web-cname ' + host('app'),
    `cloudflare:index/r2Bucket:R2Bucket uploads-bucket basefresh-${env}-uploads`,
    'cloudflare:index/workersCustomDomain:WorkersCustomDomain uploads-domain ' + host('uploads'),
    `cloudflare:index/workersScript:WorkersScript uploads basefresh-${env}-uploads`,
    'pebbletech:index:ApiFunction api',
    'pebbletech:index:Stage stage',
    'pebbletech:index:VercelProject web',
    'pebbletech:index:Worker uploads',
    'vercel:index/projectDomain:ProjectDomain web-domain ' + host('app'),
    'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable web-env-APP_BASE_URL APP_BASE_URL',
    'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable web-env-BETTER_AUTH_SECRET BETTER_AUTH_SECRET',
    'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable web-env-DATABASE_URL DATABASE_URL',
    'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable web-env-NODE_ENV NODE_ENV',
    'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable web-env-UPLOADS_BASE_URL UPLOADS_BASE_URL',
  ];
};

describe('basefresh program', () => {
  test('shared owns the Vercel project, its staging environment and the bypass, nothing else', async () => {
    const { resources, result } = await run('shared');
    expect(summary(resources)).toEqual([
      'pebbletech:index:Stage stage',
      'pebbletech:index:VercelProject web',
      'vercel:index/customEnvironment:CustomEnvironment web-staging staging',
      'vercel:index/project:Project web basefresh-web',
      'vercel:index/projectProtectionBypass:ProjectProtectionBypass web-bypass',
    ]);
    expect(Object.keys(result).sort()).toEqual(['bypassSecret', 'customEnvironmentIds', 'projectId']);
  });

  test('pr-7 owns one database and its login role, nothing else', async () => {
    const { resources } = await run('pr-7');
    expect(summary(resources)).toEqual([
      'pebbletech:index:Database db',
      'pebbletech:index:Stage stage',
      'postgresql:index/database:Database db basefresh_pr_7',
      'postgresql:index/grant:Grant db-revoke-public',
      'postgresql:index/grantRole:GrantRole db-admin-member',
      'postgresql:index/grantRole:GrantRole db-operators',
      'postgresql:index/role:Role db-owner basefresh_pr_7',
      'pulumi:providers:postgresql db-admin',
      'random:index/randomPassword:RandomPassword db-owner-password',
    ]);
  });

  test('staging builds the database, API, Worker and web env under -stg hostnames and basefresh_stg', async () => {
    const { resources } = await run('staging');
    expect(summary(resources)).toEqual([...DATABASE_STAGE('basefresh_stg'), ...RUNTIME('staging', '-stg')].sort());
  });

  test('prod builds the same set under unsuffixed hostnames and basefresh_prd', async () => {
    const { resources } = await run('prod');
    expect(summary(resources)).toEqual([...DATABASE_STAGE('basefresh_prd'), ...RUNTIME('prod', '')].sort());
  });

  test('prod: everything is protected and retained except the two domains (protected, not retained, so a delete-first replace frees the hostname)', async () => {
    const { resources } = await run('prod');
    const exposed = resources.filter((r) => r.custom && !r.type.startsWith('pulumi:providers:'));
    expect(
      exposed
        .filter((r) => !r.protect || !r.retainOnDelete)
        .map((r) => [r.name, r.protect, r.retainOnDelete])
        .sort()
    ).toEqual([
      ['uploads-domain', true, false],
      ['web-domain', true, false],
    ]);
  });

  test('staging web env goes to the shared custom environment; prod to the production target', async () => {
    const env = (resources: Registration[]) =>
      resources
        .filter((r) => r.type === 'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable')
        .map((r) => [r.inputs.projectId, r.inputs.customEnvironmentIds ?? r.inputs.targets]);
    expect(new Set(env((await run('staging')).resources).map((e) => JSON.stringify(e)))).toEqual(
      new Set([JSON.stringify(['prj_basefresh', ['env_staging']])])
    );
    expect(new Set(env((await run('prod')).resources).map((e) => JSON.stringify(e)))).toEqual(
      new Set([JSON.stringify(['prj_basefresh', ['production']])])
    );
  });

  test.each(['staging', 'prod'] as const)("%s: the API's errors alarm notifies its account's topic", async (stack) => {
    const { resources } = await run(stack);
    expect(
      resources.filter((r) => r.type === 'aws:cloudwatch/metricAlarm:MetricAlarm').map((r) => r.inputs.alarmActions)
    ).toEqual([[ALARM_TOPIC[stack]]]);
  });

  test('every IAM role in every stack carries a permissions boundary', async () => {
    for (const stack of ['shared', 'pr-7', 'staging', 'prod']) {
      const { resources } = await run(stack);
      for (const role of resources.filter((r) => r.type === 'aws:iam/role:Role')) {
        expect([stack, role.inputs.permissionsBoundary]).toEqual([stack, expect.stringMatching(/:policy\/basefresh-/)]);
      }
    }
  });

  test.each(['staging', 'prod'] as const)(
    "%s: the deploy role's IAM scope covers every role, function, log group and alarm the stack creates",
    async (env) => {
      const { resources: roleResources } = await runProgram({ project: 'basefresh-bootstrap', stack: env }, () =>
        bootstrap(env)
      );
      const policy = JSON.parse(
        roleResources.find((r) => r.type === 'aws:iam/rolePolicy:RolePolicy')!.inputs.policy
      ) as { Statement: { Sid: string; Resource: string | string[] }[] };
      const allows = (sid: string, arn: string) =>
        [policy.Statement.find((s) => s.Sid === sid)!.Resource]
          .flat()
          .some((glob) =>
            new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '.*')}$`).test(arn)
          );
      const boundaryArn = roleResources.find((r) => r.type === 'pebbletech:index:DeployRole')!.outputs!.boundaryArn;

      const { resources } = await run(env);
      const role = resources.find((r) => r.type === 'aws:iam/role:Role')!;
      const fn = resources.find((r) => r.type === 'aws:lambda/function:Function')!;
      const logs = resources.find((r) => r.type === 'aws:cloudwatch/logGroup:LogGroup')!;
      const alarm = resources.find((r) => r.type === 'aws:cloudwatch/metricAlarm:MetricAlarm')!;
      expect([
        allows('RolesOnlyWithBoundary', `arn:aws:iam::123456789012:role/${role.inputs.name}`),
        allows('PassRolesToLambda', `arn:aws:iam::123456789012:role/${role.inputs.name}`),
        allows('Lambda', `arn:aws:lambda:ap-southeast-1:123456789012:function:${fn.inputs.name}`),
        allows('Logs', `arn:aws:logs:ap-southeast-1:123456789012:log-group:${logs.inputs.name}`),
        allows('Alarms', `arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:${alarm.inputs.name}`),
        role.inputs.permissionsBoundary,
      ]).toEqual([true, true, true, true, true, boundaryArn]);
    }
  );
});
