import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  ApiFunction,
  type ApiFunctionArgs,
  MissingDomainError,
  NamespaceError,
  OwnershipError,
  PermissionsBoundaryError,
  Stage,
} from './index.js';
import { runProgram } from './testing.js';

const code = mkdtempSync(join(tmpdir(), 'pebbletech-infra-api-'));
writeFileSync(join(code, 'index.js'), 'export const handler = async () => ({ statusCode: 200 });\n');

const domainFor = (stage: Stage) => ({ hostname: stage.hostname('api', 'pebbletech.my'), zoneId: 'zone-1' });

async function apiIn(stack: string, args: Partial<Omit<ApiFunctionArgs, 'stage'>> = {}) {
  return runProgram({ project: 'basefresh', stack }, () => {
    const stage = new Stage('stage', { product: 'basefresh' });
    return new ApiFunction('api', { stage, code, domain: domainFor(stage), ...args });
  });
}

describe('ApiFunction', () => {
  test('creates the function, its role, logs, HTTP API, regional certificate, domain and CNAMEs', async () => {
    const { resources } = await apiIn('staging');
    const children = resources.filter((r) => r.parent.endsWith('pebbletech:index:ApiFunction::api'));
    expect(children.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      'aws:acm/certificate:Certificate api-certificate',
      'aws:acm/certificateValidation:CertificateValidation api-certificate-validated',
      'aws:apigatewayv2/api:Api api-api',
      'aws:apigatewayv2/apiMapping:ApiMapping api-mapping',
      'aws:apigatewayv2/domainName:DomainName api-domain',
      'aws:apigatewayv2/integration:Integration api-integration',
      'aws:apigatewayv2/route:Route api-route',
      'aws:apigatewayv2/stage:Stage api-stage',
      'aws:cloudwatch/logGroup:LogGroup api-logs',
      'aws:iam/role:Role api-role',
      'aws:iam/rolePolicyAttachment:RolePolicyAttachment api-basic-execution',
      'aws:lambda/function:Function api',
      'aws:lambda/permission:Permission api-invoke',
      'cloudflare:index/dnsRecord:DnsRecord api-certificate-validation',
      'cloudflare:index/dnsRecord:DnsRecord api-cname',
    ]);
  });

  test('the function runs nodejs22.x under its stage name with 1024 MB, 29 s and a 30-day log group', async () => {
    const { resources } = await apiIn('staging', { environment: { NODE_ENV: 'production' } });
    const fn = resources.find((r) => r.type === 'aws:lambda/function:Function')!;
    expect(fn.inputs).toMatchObject({
      name: 'basefresh-staging-api',
      runtime: 'nodejs22.x',
      handler: 'index.handler',
      memorySize: 1024,
      timeout: 29,
      environment: { variables: { NODE_ENV: 'production' } },
      loggingConfig: { logGroup: '/aws/lambda/basefresh-staging-api' },
      tags: { product: 'basefresh', env: 'staging', 'managed-by': 'pulumi' },
    });
    expect(resources.find((r) => r.type === 'aws:cloudwatch/logGroup:LogGroup')!.inputs).toMatchObject({
      name: '/aws/lambda/basefresh-staging-api',
      retentionInDays: 30,
    });
  });

  test.each([
    [30, 29],
    [300, 29],
    [10, 10],
  ])('a timeout of %i s becomes %i s', async (timeout, expected) => {
    const { resources } = await apiIn('staging', { timeout });
    expect(resources.find((r) => r.type === 'aws:lambda/function:Function')!.inputs.timeout).toBe(expected);
  });

  test('the role carries the default boundary and only the basic execution policy', async () => {
    const { resources } = await apiIn('staging');
    const role = resources.find((r) => r.type === 'aws:iam/role:Role')!;
    expect(role.inputs).toMatchObject({
      name: 'basefresh-staging-api',
      permissionsBoundary: 'arn:aws:iam::123456789012:policy/basefresh-staging-boundary',
    });
    expect(JSON.parse(role.inputs.assumeRolePolicy).Statement).toEqual([
      { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
    ]);
    const attachments = resources.filter((r) => r.type.startsWith('aws:iam/') && r.type !== 'aws:iam/role:Role');
    expect(attachments.map((r) => r.inputs.policyArn)).toEqual([
      'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ]);
  });

  test('the API has no execute-api endpoint and is reached through a regional custom domain', async () => {
    const { resources } = await apiIn('prod');
    const byType = (type: string) => resources.filter((r) => r.type === type);
    expect(byType('aws:apigatewayv2/api:Api')[0]!.inputs).toMatchObject({
      protocolType: 'HTTP',
      disableExecuteApiEndpoint: true,
    });
    expect(byType('aws:apigatewayv2/domainName:DomainName')[0]!.inputs).toMatchObject({
      domainName: 'api-basefresh.pebbletech.my',
      domainNameConfiguration: { endpointType: 'REGIONAL', securityPolicy: 'TLS_1_2' },
    });
    expect(byType('aws:acm/certificate:Certificate')[0]!.inputs).toMatchObject({
      domainName: 'api-basefresh.pebbletech.my',
      validationMethod: 'DNS',
    });
    expect(byType('aws:apigatewayv2/integration:Integration')[0]!.inputs).toMatchObject({ timeoutMilliseconds: 30000 });
    const records = byType('cloudflare:index/dnsRecord:DnsRecord').map((r) => r.inputs);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'api-basefresh.pebbletech.my',
          type: 'CNAME',
          content: 'd-api-domain.execute-api.ap-southeast-1.amazonaws.com',
          proxied: false,
        }),
        expect.objectContaining({
          name: '_validation.api-basefresh.pebbletech.my',
          content: '_validation.acm-validations.aws',
          proxied: false,
        }),
      ])
    );
  });

  test('no resource asks for a non-default (us-east-1) provider', async () => {
    const { resources } = await apiIn('prod');
    expect(resources.filter((r) => r.type.startsWith('pulumi:providers:aws'))).toEqual([]);
  });

  test('on prod every child is protected and retained', async () => {
    const { resources } = await apiIn('prod');
    const children = resources.filter((r) => r.custom);
    expect(children).toHaveLength(15);
    expect(children.filter((r) => !r.protect || !r.retainOnDelete).map((r) => r.name)).toEqual([]);
  });

  test('outputs are registered', async () => {
    const { resources } = await apiIn('staging');
    expect(resources.find((r) => r.type === 'pebbletech:index:ApiFunction')!.outputs).toEqual({
      functionName: 'basefresh-staging-api',
      functionArn: 'arn:aws:lambda:ap-southeast-1:123456789012:function:basefresh-staging-api',
      apiId: 'api-api-id',
      hostname: 'api-basefresh-stg.pebbletech.my',
      url: 'https://api-basefresh-stg.pebbletech.my',
    });
  });

  test('refuses to build without a domain', async () => {
    await expect(apiIn('staging', { domain: undefined })).rejects.toThrow(MissingDomainError);
    await expect(apiIn('staging', { domain: { hostname: '', zoneId: 'zone-1' } })).rejects.toThrow(MissingDomainError);
  });

  test("refuses another stage's hostname", async () => {
    await expect(
      apiIn('staging', { domain: { hostname: 'api-basefresh.pebbletech.my', zoneId: 'zone-1' } })
    ).rejects.toThrow(NamespaceError);
  });

  test.each([null, '', 'not-an-arn', 'arn:aws:iam::123456789012:role/x'])(
    'refuses the permissions boundary "%s"',
    async (permissionsBoundary) => {
      await expect(apiIn('staging', { permissionsBoundary: permissionsBoundary as string })).rejects.toThrow(
        PermissionsBoundaryError
      );
    }
  );

  test('refuses the shared stack', async () => {
    await expect(
      apiIn('shared', { domain: { hostname: 'api-basefresh.pebbletech.my', zoneId: 'zone-1' } })
    ).rejects.toThrow(OwnershipError);
  });
});
