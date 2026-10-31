import { defaultMocks, type Registration, runProgram } from '@pebbletech/infra/testing';
import type * as pulumi from '@pulumi/pulumi';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { basefresh } from './app.js';

/**
 * Every enum-valued input the toolkit sets, spelled as the provider accepts it. Lists marked `validated` are the
 * provider's own refusal message for a wrong value (pulumi preview against the real plugin); the SDK's doc comments are
 * not a source, because the bridge rewrites `snake_case` there (`onlyPreviewDeployments` is refused). Lists marked
 * `docs` are values the provider passes through unchecked, so only the API or the database catches a wrong one.
 */
const ENUMS: Record<string, Record<string, readonly string[]>> = {
  'vercel:index/project:Project': {
    // validated, vercel 5.21.1
    'vercelAuthentication.deploymentType': [
      'standard_protection_new',
      'standard_protection',
      'all_deployments',
      'only_preview_deployments',
      'none',
    ],
  },
  'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable': {
    'targets[]': ['production', 'preview', 'development'], // validated
  },
  'cloudflare:index/dnsRecord:DnsRecord': {
    // docs (cloudflare 6.23.1 dnsRecord "Available values", subset); not checked before the API call
    type: ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'OPENPGPKEY', 'PTR', 'TXT', 'CAA', 'CERT', 'DNSKEY', 'DS', 'HTTPS', 'LOC'],
  },
  'cloudflare:index/workersScript:WorkersScript': {
    'bindings[].type': ['r2_bucket', 'plain_text', 'secret_text', 'kv_namespace', 'service', 'json', 'd1', 'queue'], // validated (subset)
    'compatibilityFlags[]': ['nodejs_compat'], // docs (Workers compatibility flags); not checked before the API call
  },
  'aws:lambda/function:Function': {
    runtime: ['nodejs20.x', 'nodejs22.x', 'nodejs24.x'], // validated (subset)
    'loggingConfig.logFormat': ['JSON', 'Text'], // validated
  },
  'aws:apigatewayv2/api:Api': { protocolType: ['HTTP', 'WEBSOCKET'] }, // validated
  'aws:apigatewayv2/integration:Integration': {
    integrationType: ['AWS', 'HTTP', 'MOCK', 'HTTP_PROXY', 'AWS_PROXY'], // validated
    payloadFormatVersion: ['1.0', '2.0'], // validated
  },
  'aws:apigatewayv2/route:Route': { routeKey: ['$default'] }, // docs (HTTP API default route); not checked
  'aws:apigatewayv2/stage:Stage': { name: ['$default'] }, // docs (HTTP API default stage); not checked
  'aws:acm/certificate:Certificate': { validationMethod: ['DNS', 'EMAIL', 'HTTP'] }, // validated
  'aws:cloudwatch/metricAlarm:MetricAlarm': {
    // validated, aws 7.51.1
    comparisonOperator: [
      'GreaterThanOrEqualToThreshold',
      'GreaterThanThreshold',
      'LessThanThreshold',
      'LessThanOrEqualToThreshold',
      'LessThanLowerOrGreaterThanUpperThreshold',
      'LessThanLowerThreshold',
      'GreaterThanUpperThreshold',
    ],
    statistic: ['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'], // validated
    treatMissingData: ['breaching', 'notBreaching', 'ignore', 'missing'], // docs (PutMetricAlarm); not checked before the API call
  },
  'aws:apigatewayv2/domainName:DomainName': {
    'domainNameConfiguration.endpointType': ['REGIONAL'], // docs ("Valid values: REGIONAL"); not checked
    'domainNameConfiguration.securityPolicy': ['TLS_1_2'], // validated
  },
  'pulumi:providers:postgresql': {
    sslmode: ['disable', 'require', 'verify-ca', 'verify-full'], // docs (lib/pq); not checked before connecting
  },
  'postgresql:index/grant:Grant': {
    // validated (subset)
    objectType: ['database', 'function', 'procedure', 'routine', 'schema', 'sequence', 'table', 'foreign_data_wrapper'],
    // docs (PostgreSQL GRANT, subset); checked only when the grant runs
    'privileges[]': [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'CREATE',
      'CONNECT',
      'USAGE',
    ],
  },
  'postgresql:index/defaultPrivileges:DefaultPrivileges': {
    objectType: ['table', 'sequence', 'function', 'routine', 'type', 'schema'], // validated
    'privileges[]': ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'USAGE'], // docs (subset)
  },
};

/** Values at a dotted path; `[]` steps into every array element. */
function valuesAt(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const step of path.split('.')) {
    const key = step.replace(/\[\]$/, '');
    current = current.flatMap((item) => {
      const next = (item as Record<string, unknown> | undefined)?.[key];
      if (next === undefined) return [];
      return step.endsWith('[]') ? (next as unknown[]) : [next];
    });
  }
  return current;
}

const root = join(import.meta.dirname, '..');
const mocks: pulumi.runtime.Mocks = {
  ...defaultMocks,
  call(args) {
    if (args.token === 'vercel:index/getProject:getProject') return { ...args.inputs, id: 'prj_basefresh' };
    if (args.token === 'vercel:index/getCustomEnvironment:getCustomEnvironment') {
      return { ...args.inputs, id: 'env_staging' };
    }
    return defaultMocks.call(args);
  },
};

async function everyStack(): Promise<Registration[]> {
  const all: Registration[] = [];
  for (const stack of ['shared', 'pr-7', 'staging', 'prod']) {
    const { resources } = await runProgram({ project: 'basefresh', stack, mocks }, () =>
      basefresh({
        apex: 'pebbletech.my',
        cloudflareZoneId: 'zone-1',
        cloudflareAccountId: 'account-1',
        pgAdminUrl: 'postgresql://postgres.abc123:admin@sin.pg.psdb.cloud:5432/postgres',
        ...(stack === 'staging' || stack === 'prod' ? { pgRuntime: { role: 'basefresh_app', password: 'pw' } } : {}),
        authSecret: 'auth-secret',
        bundles: { api: join(root, 'bundles/api'), uploads: join(root, 'bundles/uploads/server.js') },
      })
    );
    all.push(...resources.map((r) => ({ ...r, name: `${stack}/${r.name}` })));
  }
  return all;
}

const ROWS = Object.entries(ENUMS).flatMap(([type, paths]) =>
  Object.entries(paths).map(([path, allowed]) => [type, path, allowed] as const)
);

let registered: Promise<Registration[]> | undefined;
const resourcesOfEveryStack = () => (registered ??= everyStack());

describe('provider enum inputs', () => {
  // One test per row and one assertion per value, counted: deleting the per-value check fails the count, and deleting
  // the count leaves the per-value check failing on a misspelled value.
  test.each(ROWS)('%s %s is spelled as its provider accepts it', async (type, path, allowed) => {
    const values = (await resourcesOfEveryStack())
      .filter((r) => r.type === type)
      .flatMap((r) => valuesAt(r.inputs, path).map((value) => [r.name, value] as const));
    expect.assertions(values.length + 1);
    // Every row is reached, so a renamed property cannot leave a row checking nothing.
    expect(values.length).toBeGreaterThan(0);
    for (const [name, value] of values) expect([name, value]).toEqual([name, expect.toBeOneOf(allowed)]);
  });

  test('the Vercel project protects previews with the provider spelling', async () => {
    const project = (await resourcesOfEveryStack()).find((r) => r.type === 'vercel:index/project:Project')!;
    expect(project.inputs.vercelAuthentication).toEqual({ deploymentType: 'only_preview_deployments' });
  });
});
