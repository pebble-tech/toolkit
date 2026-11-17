import * as pulumi from '@pulumi/pulumi';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  type NodeVersion,
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
  test('owns the project, a staging custom environment, the protection bypass and the placeholder; nothing else', async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const children = resources.filter((r) => r.custom);
    expect(children.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      'vercel:index/customEnvironment:CustomEnvironment web-staging',
      'vercel:index/deployment:Deployment web-placeholder',
      'vercel:index/project:Project web',
      'vercel:index/projectProtectionBypass:ProjectProtectionBypass web-bypass',
    ]);
  });

  test("deploys the package's static page to the new project, naming no target, with no build", async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const page = fileURLToPath(new URL('../placeholder/index.html', import.meta.url));
    const content = readFileSync(page);
    const sha1 = createHash('sha1').update(content).digest('hex');
    // No `production` input: Vercel makes a target-less deployment production only on a project that has none, so an
    // existing project's production deployment is never replaced by this page.
    expect(ofType(resources, 'vercel:index/deployment:Deployment').map((r) => r.inputs)).toEqual([
      {
        projectId: 'web-id',
        files: { [page]: `${content.length}~${sha1}` },
        pathPrefix: fileURLToPath(new URL('../placeholder', import.meta.url)),
        projectSettings: { buildCommand: '', installCommand: '' },
      },
    ]);
  });

  test('the placeholder is created once: every input that would replace it is ignored, and it is protected', async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const placeholders = ofType(resources, 'vercel:index/deployment:Deployment');
    expect(placeholders.map((r) => [r.ignoreChanges, r.protect, r.retainOnDelete])).toEqual([
      [['files', 'pathPrefix', 'projectSettings', 'production'], true, true],
    ]);
  });

  test('staging and prod deploy no placeholder', async () => {
    expect.assertions(2);
    for (const stack of ['staging', 'prod']) {
      const { resources } = await vercelIn(stack, stageArgs(stack));
      expect(ofType(resources, 'vercel:index/deployment:Deployment')).toEqual([]);
    }
  });

  test('the project has no Git connection, private source and Vercel Authentication on previews', async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const project = ofType(resources, 'vercel:index/project:Project')[0];
    expect(project.inputs).toEqual({
      name: 'basefresh-web',
      ...PROJECT,
      nodeVersion: '24.x',
      publicSource: false,
      vercelAuthentication: { deploymentType: 'only_preview_deployments' },
    });
  });

  test('pins the Node version the product declares, or the toolkit default', async () => {
    expect.assertions(2);
    const pinned = await vercelIn('shared', { project: { ...PROJECT, nodeVersion: '22.x' } });
    expect(ofType(pinned.resources, 'vercel:index/project:Project')[0].inputs.nodeVersion).toBe('22.x');
    const unset = await vercelIn('shared', { project: PROJECT });
    expect(ofType(unset.resources, 'vercel:index/project:Project')[0].inputs.nodeVersion).toBe('24.x');
  });

  test('types the Node version as the provider accepts it, and passes each one through', async () => {
    const accepted: NodeVersion[] = ['18.x', '20.x', '22.x', '24.x'];
    // @ts-expect-error provider 5.21.1 refuses 26.x
    const newer: NodeVersion = '26.x';
    // @ts-expect-error a bare major is not Vercel's spelling
    const bare: NodeVersion = '24';
    expect.assertions(accepted.length + 1);
    expect([newer, bare]).toEqual(['26.x', '24']);
    for (const nodeVersion of accepted) {
      const { resources } = await vercelIn('shared', { project: { ...PROJECT, nodeVersion } });
      expect(ofType(resources, 'vercel:index/project:Project')[0].inputs.nodeVersion).toBe(nodeVersion);
    }
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

  test.each(['staging', 'prod'])(
    '%s replaces the project domain delete-first, and nothing else: a hostname is on one project',
    async (stack) => {
      expect.assertions(1);
      const { resources } = await vercelIn(stack, stageArgs(stack));
      expect(resources.filter((r) => r.deleteBeforeReplace).map((r) => `${r.type} ${r.name}`)).toEqual([
        'vercel:index/projectDomain:ProjectDomain web-domain',
      ]);
    }
  );

  test('on prod every child is protected, and every child but the project domain is retained', async () => {
    expect.assertions(1);
    const { resources } = await vercelIn('prod', stageArgs('prod'));
    const children = resources.filter((r) => r.custom).sort((a, b) => a.name.localeCompare(b.name));
    // A retained domain would stay on the old project on a delete-first replace and block the new project's claim.
    expect(children.map((r) => [r.name, r.protect, r.retainOnDelete])).toEqual([
      ['web-cname', true, true],
      ['web-domain', true, false],
      ['web-env-APP_BASE_URL', true, true],
      ['web-env-BETTER_AUTH_SECRET', true, true],
      ['web-env-DATABASE_URL', true, true],
    ]);
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
