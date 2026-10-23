import * as pulumi from '@pulumi/pulumi';
import { describe, expect, test } from 'vitest';

import {
  NamespaceError,
  OwnershipError,
  PlainTextSecretError,
  Stage,
  VercelProject,
  type VercelProjectArgs,
} from './index.js';
import { runProgram, valueOf } from './testing.js';

const PROJECT = {
  rootDirectory: 'apps/web',
  buildCommand: "cd ../.. && pnpm --filter '@base/app' build",
  installCommand: 'cd ../.. && pnpm install --prod=false',
  devCommand: 'cd ../.. && pnpm dev:app',
};

async function vercelIn(stack: string, args: Partial<Omit<VercelProjectArgs, 'stage'>>) {
  return runProgram({ project: 'basefresh', stack }, async () => {
    const stage = new Stage('stage', { product: 'basefresh' });
    const project = new VercelProject('web', { stage, ...args });
    return { project, bypassIsSecret: project.bypassSecret ? await pulumi.isSecret(project.bypassSecret) : undefined };
  });
}

const stageArgs = (stage: string) => ({
  projectId: 'prj_123',
  ...(stage === 'staging' ? { customEnvironmentId: 'env_staging' } : {}),
  vars: { APP_BASE_URL: 'https://app' },
  secrets: { DATABASE_URL: 'postgresql://x', BETTER_AUTH_SECRET: 'shh' },
  domain: {
    hostname: stage === 'staging' ? 'app-basefresh-stg.pebbletech.my' : 'app-basefresh.pebbletech.my',
    zoneId: 'zone-1',
  },
});

const ofType = (resources: { type: string }[], type: string) => resources.filter((r) => r.type === type) as any[];

describe('VercelProject on the shared stack', () => {
  test('owns the project, a staging custom environment and the protection bypass; nothing else', async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const children = resources.filter((r) => r.custom);
    expect(children.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      'vercel:index/customEnvironment:CustomEnvironment web-staging',
      'vercel:index/project:Project web',
      'vercel:index/projectProtectionBypass:ProjectProtectionBypass web-bypass',
    ]);
  });

  test('the project has no Git connection, private source and Vercel Authentication on previews', async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const project = ofType(resources, 'vercel:index/project:Project')[0];
    expect(project.inputs).toEqual({
      name: 'basefresh-web',
      ...PROJECT,
      publicSource: false,
      vercelAuthentication: { deploymentType: 'onlyPreviewDeployments' },
    });
  });

  test('the bypass secret is a secret output and outputs are registered', async () => {
    const { result, resources } = await vercelIn('shared', { project: PROJECT });
    expect(result.bypassIsSecret).toBe(true);
    expect(await valueOf(result.project.bypassSecret!)).toBe('mock-bypass-web-bypass');
    expect(resources.find((r) => r.type === 'pebbletech:index:VercelProject')!.outputs).toEqual({
      projectId: 'web-id',
      customEnvironmentIds: { staging: 'web-staging-id' },
      bypassSecret: 'mock-bypass-web-bypass',
    });
  });

  test('protects and retains what it owns, since production deploys to it', async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    expect(resources.filter((r) => r.custom && (!r.protect || !r.retainOnDelete))).toEqual([]);
  });

  test('refuses a project name outside the product', async () => {
    await expect(vercelIn('shared', { project: { ...PROJECT, name: 'other-web' } })).rejects.toThrow(NamespaceError);
  });

  test('refuses env vars or domains on shared, and a missing project', async () => {
    await expect(vercelIn('shared', { project: PROJECT, vars: { A: 'b' } })).rejects.toThrow(OwnershipError);
    await expect(vercelIn('shared', {})).rejects.toThrow(OwnershipError);
  });
});

describe('VercelProject on staging and prod', () => {
  test('staging scopes every env var to its custom environment and marks secrets sensitive', async () => {
    const { resources } = await vercelIn('staging', stageArgs('staging'));
    const variables = ofType(resources, 'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable');
    expect(variables.map((v) => v.inputs)).toEqual([
      {
        projectId: 'prj_123',
        key: 'APP_BASE_URL',
        value: 'https://app',
        sensitive: false,
        customEnvironmentIds: ['env_staging'],
      },
      {
        projectId: 'prj_123',
        key: 'DATABASE_URL',
        value: 'postgresql://x',
        sensitive: true,
        customEnvironmentIds: ['env_staging'],
      },
      {
        projectId: 'prj_123',
        key: 'BETTER_AUTH_SECRET',
        value: 'shh',
        sensitive: true,
        customEnvironmentIds: ['env_staging'],
      },
    ]);
    // The provider keeps every value secret in state; `sensitive` is what makes Vercel hide it.
    expect(variables.filter((v) => v.inputs.sensitive).map((v) => v.secretInputs)).toEqual([['value'], ['value']]);
  });

  test('prod targets production and creates no project', async () => {
    const { resources } = await vercelIn('prod', stageArgs('prod'));
    expect(ofType(resources, 'vercel:index/project:Project')).toEqual([]);
    const variables = ofType(resources, 'vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable');
    expect(variables.map((v) => v.inputs.targets)).toEqual([['production'], ['production'], ['production']]);
  });

  test('binds the domain to the custom environment and points an unproxied CNAME at Vercel', async () => {
    const { resources } = await vercelIn('staging', stageArgs('staging'));
    expect(ofType(resources, 'vercel:index/projectDomain:ProjectDomain')[0].inputs).toEqual({
      projectId: 'prj_123',
      domain: 'app-basefresh-stg.pebbletech.my',
      customEnvironmentId: 'env_staging',
    });
    expect(ofType(resources, 'cloudflare:index/dnsRecord:DnsRecord')[0].inputs).toEqual({
      zoneId: 'zone-1',
      name: 'app-basefresh-stg.pebbletech.my',
      type: 'CNAME',
      content: 'cname.vercel-dns.com',
      ttl: 1,
      proxied: false,
    });
  });

  test('on prod every child is protected and retained', async () => {
    const { resources } = await vercelIn('prod', stageArgs('prod'));
    const children = resources.filter((r) => r.custom);
    expect(children).toHaveLength(5);
    expect(children.filter((r) => !r.protect || !r.retainOnDelete)).toEqual([]);
  });

  test('refuses a secret-looking name as a plain var', async () => {
    await expect(vercelIn('staging', { ...stageArgs('staging'), vars: { AI_GATEWAY_API_KEY: 'k' } })).rejects.toThrow(
      PlainTextSecretError
    );
  });

  test('refuses staging without its custom environment, and a stage without the project id', async () => {
    await expect(vercelIn('staging', { ...stageArgs('staging'), customEnvironmentId: undefined })).rejects.toThrow(
      OwnershipError
    );
    await expect(vercelIn('prod', { ...stageArgs('prod'), projectId: undefined })).rejects.toThrow(OwnershipError);
  });

  test('refuses to own the project outside shared, and refuses previews outright', async () => {
    await expect(vercelIn('prod', { ...stageArgs('prod'), project: PROJECT })).rejects.toThrow(OwnershipError);
    await expect(vercelIn('pr-7', { projectId: 'prj_123' })).rejects.toThrow(OwnershipError);
  });

  test("refuses another stage's domain", async () => {
    await expect(vercelIn('prod', { ...stageArgs('prod'), domain: stageArgs('staging').domain })).rejects.toThrow(
      NamespaceError
    );
  });
});
