import * as pulumi from '@pulumi/pulumi';
import * as vercel from '@pulumiverse/vercel';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  type NodeVersion,
  NamespaceError,
  OwnershipError,
  PlainTextSecretError,
  type SkewProtectionMaxAge,
  Stage,
  VercelProject,
  type VercelProjectArgs,
} from './index.js';
import { defaultMocks, type Registration, runProgram, valueOf } from './testing.js';

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

/** A file shipped in `placeholder/`, or nothing when the package ships none of that name. */
const shipped = (file: string) => {
  const path = fileURLToPath(new URL(`../placeholder/${file}`, import.meta.url));
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
};

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

  test("uploads the package's page and its vercel.json under the project's root directory, with no projectSettings", async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const [placeholder] = ofType(resources, 'vercel:index/deployment:Deployment');
    const entry = (file: string) => `${shipped(file).length}~${createHash('sha1').update(shipped(file)).digest('hex')}`;
    const { files, pathPrefix, ...rest } = placeholder?.inputs ?? {};
    // What Vercel receives: each file's name once the provider strips `pathPrefix`, its size and sha1, and the local
    // copy the provider uploads from. No `projectSettings` and no `production`: the provider would drop empty commands,
    // Vercel saves a first deployment's projectSettings for the next ones, and a target-less deployment is production
    // only on a project that has none.
    const uploaded = Object.entries((files ?? {}) as Record<string, string>).map(([path, sizeSha]) => [
      path.slice(String(pathPrefix).length + 1),
      sizeSha,
      readFileSync(path).equals(shipped(path.endsWith('vercel.json') ? 'vercel.json' : 'index.html')),
    ]);
    // Under a directory of this user's own: another user's under a shared temporary directory is not writable.
    const own = join(tmpdir(), `pebbletech-infra-placeholder-${process.getuid?.() ?? userInfo().username}`);
    expect([rest, uploaded.sort(), String(pathPrefix).startsWith(`${own}/`)]).toEqual([
      { projectId: 'web-id' },
      [
        ['apps/web/index.html', entry('index.html'), true],
        ['apps/web/vercel.json', entry('vercel.json'), true],
      ],
      true,
    ]);
  });

  test('the shipped vercel.json skips the install, runs a no-op build and serves the page as is', async () => {
    const config = JSON.parse(shipped('vercel.json').toString('utf8') || '{}');
    expect(config).toEqual({
      framework: null,
      installCommand: '',
      buildCommand: "echo 'Placeholder page: nothing to build.'",
      outputDirectory: '.',
    });
  });

  test('writes each local copy once: a later evaluation leaves the file the provider may be reading untouched', async () => {
    // Every evaluation on the machine (another product's, a test's) names the same paths. Rewriting one in place
    // would let a provider reading it for an upload see it empty; it is written once, by a rename, and then left alone.
    const first = await vercelIn('shared', { project: PROJECT });
    const paths = Object.keys(ofType(first.resources, 'vercel:index/deployment:Deployment')[0]?.inputs.files ?? {});
    const before = paths.map((path) => [statSync(path).ino, statSync(path).mtimeMs]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await vercelIn('shared', { project: PROJECT });
    expect(paths.map((path) => [statSync(path).ino, statSync(path).mtimeMs])).toEqual(before);
  });

  test('refuses a root directory outside the project', async () => {
    await expect(vercelIn('shared', { project: { ...PROJECT, rootDirectory: '../elsewhere' } })).rejects.toThrow(
      OwnershipError
    );
  });

  test('the placeholder is created once: every input that would replace it is ignored, and it is protected', async () => {
    const { resources } = await vercelIn('shared', { project: PROJECT });
    const placeholders = ofType(resources, 'vercel:index/deployment:Deployment');
    expect(placeholders.map((r) => [r.ignoreChanges, r.protect, r.retainOnDelete])).toEqual([
      [['files', 'pathPrefix', 'production'], true, true],
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
      skewProtection: '12 hours',
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

  test("turns Skew Protection on with Pro's 12 hour maximum age, sets another age, or turns it off", async () => {
    const inputs = async (project: typeof PROJECT & { skewProtection?: SkewProtectionMaxAge | false }) =>
      ofType((await vercelIn('shared', { project })).resources, 'vercel:index/project:Project')[0].inputs;
    const [unset, sevenDays, off] = [
      await inputs(PROJECT),
      await inputs({ ...PROJECT, skewProtection: '7 days' }),
      await inputs({ ...PROJECT, skewProtection: false }),
    ];
    // Off is no input at all: the provider then sends a max age of 0, which Vercel reads as off.
    expect([unset.skewProtection, sevenDays.skewProtection, 'skewProtection' in off]).toEqual([
      '12 hours',
      '7 days',
      false,
    ]);
  });

  test('types the Skew Protection maximum age as the provider accepts it, and passes each one through', async () => {
    const accepted: SkewProtectionMaxAge[] = ['30 minutes', '4 hours', '12 hours', '1 day', '7 days'];
    // @ts-expect-error provider 5.21.1 has no 1 hour
    const hour: SkewProtectionMaxAge = '1 hour';
    // @ts-expect-error seconds are what the provider sends, not what it takes
    const seconds: SkewProtectionMaxAge = '43200';
    expect.assertions(accepted.length + 1);
    expect([hour, seconds]).toEqual(['1 hour', '43200']);
    for (const skewProtection of accepted) {
      const { resources } = await vercelIn('shared', { project: { ...PROJECT, skewProtection } });
      expect(ofType(resources, 'vercel:index/project:Project')[0].inputs.skewProtection).toBe(skewProtection);
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

describe('VercelProject production domains (custom and apex hostnames on prod)', () => {
  const ZONES: Record<string, string> = { 'zone-1': 'pebbletech.my', 'zone-2': 'client.com' };
  const TXT = (zone: string, host: string) => ({
    domain: `_vercel.${zone}`,
    reason: 'pending_domain_verification',
    type: 'TXT',
    value: `vc-domain-verify=${host},abc123`,
  });
  /** The engine faked as the providers answer: Cloudflare zone names, Vercel's challenges and recommended records. */
  const mocks = (verified: Record<string, boolean> = {}): pulumi.runtime.Mocks => ({
    newResource(args) {
      const base = defaultMocks.newResource(args) as { id: string; state: Record<string, any> };
      if (args.type !== 'vercel:index/projectDomain:ProjectDomain') return base;
      const host = String(args.inputs.domain);
      const zone = host.endsWith('client.com') ? 'client.com' : 'pebbletech.my';
      const done = verified[host] ?? false;
      return { ...base, state: { ...base.state, verified: done, verifications: done ? [] : [TXT(zone, host)] } };
    },
    call(args) {
      if (args.token === 'cloudflare:index/getZone:getZone') {
        return { id: args.inputs.zoneId, zoneId: args.inputs.zoneId, name: ZONES[args.inputs.zoneId] ?? '' };
      }
      if (args.token === 'vercel:index/getDomainConfig:getDomainConfig') {
        return { ...args.inputs, recommendedCname: 'cname.vercel-dns-017.com.', recommendedIpv4s: ['76.76.21.21'] };
      }
      return defaultMocks.call(args);
    },
  });

  const prodWith = (
    productionDomains: VercelProjectArgs['productionDomains'],
    extra: Partial<VercelProjectArgs> = {},
    verified?: Record<string, boolean>,
    stack = 'prod'
  ) =>
    runProgram({ project: 'basefresh', stack, mocks: mocks(verified) }, () => {
      const stage = new Stage('stage', { product: 'basefresh' });
      return new VercelProject('web', { stage, projectId: 'prj_123', productionDomains, ...extra });
    });

  const NEW = { hostname: 'new.pebbletech.my', zoneName: 'pebbletech.my', zoneId: 'zone-1' };
  const CHALLENGE = 'vc-domain-verify=pebbletech.my,abc123';
  const APEX = { hostname: 'pebbletech.my', zoneName: 'pebbletech.my', zoneId: 'zone-1', verificationTxt: CHALLENGE };

  test('binds each hostname to production with an unproxied CNAME, the apex by its full name, and the opt-in TXT', async () => {
    const { resources } = await prodWith([NEW, APEX]);
    const children = resources.filter((r) => r.custom).sort((a, b) => a.name.localeCompare(b.name));
    expect(
      children.map((r) => [
        r.type,
        r.name,
        r.inputs,
        r.protect,
        r.retainOnDelete,
        r.deleteBeforeReplace,
        r.ignoreChanges,
      ])
    ).toEqual([
      [
        'cloudflare:index/dnsRecord:DnsRecord',
        'web-cname-new.pebbletech.my',
        {
          zoneId: 'zone-1',
          name: 'new.pebbletech.my',
          type: 'CNAME',
          content: 'cname.vercel-dns-017.com',
          ttl: 1,
          proxied: false,
        },
        true,
        true,
        false,
        [],
      ],
      [
        'cloudflare:index/dnsRecord:DnsRecord',
        'web-cname-pebbletech.my',
        {
          zoneId: 'zone-1',
          name: 'pebbletech.my',
          type: 'CNAME',
          content: 'cname.vercel-dns-017.com',
          ttl: 1,
          proxied: false,
        },
        true,
        true,
        false,
        [],
      ],
      [
        'vercel:index/projectDomain:ProjectDomain',
        'web-domain-new.pebbletech.my',
        { projectId: 'prj_123', domain: 'new.pebbletech.my' },
        true,
        false,
        true,
        [],
      ],
      [
        'vercel:index/projectDomain:ProjectDomain',
        'web-domain-pebbletech.my',
        { projectId: 'prj_123', domain: 'pebbletech.my' },
        true,
        false,
        true,
        [],
      ],
      [
        'cloudflare:index/dnsRecord:DnsRecord',
        'web-vercel-txt-pebbletech.my',
        {
          zoneId: 'zone-1',
          name: '_vercel.pebbletech.my',
          type: 'TXT',
          content: 'vc-domain-verify=pebbletech.my,abc123',
          ttl: 1,
        },
        false,
        true,
        false,
        [],
      ],
    ]);
  });

  test('the stage domain keeps its resources and names beside production domains', async () => {
    const domain = { hostname: 'app-basefresh.pebbletech.my', zoneId: 'zone-1' };
    const alone = await prodWith(undefined, { domain });
    const beside = await prodWith([NEW, APEX], { domain });
    const stageDomain = (resources: Registration[]) =>
      resources
        .filter((r) => r.name === 'web-domain' || r.name === 'web-cname')
        .map((r) => [r.urn, r.inputs, r.protect, r.retainOnDelete, r.deleteBeforeReplace])
        .sort();
    expect([stageDomain(beside.resources), stageDomain(alone.resources).length]).toEqual([
      stageDomain(alone.resources),
      2,
    ]);
  });

  test('a hostname keeps its URNs when another is added, removed or listed first', async () => {
    const urnsOf = async (domains: (typeof NEW)[]) =>
      (await prodWith(domains)).resources
        .filter((r) => r.name.endsWith('new.pebbletech.my'))
        .map((r) => r.urn)
        .sort();
    const alone = await urnsOf([NEW]);
    expect([await urnsOf([NEW, APEX]), await urnsOf([APEX, NEW]), alone.length]).toEqual([alone, alone, 2]);
  });

  test("a client's zone gets no DNS from Pulumi: clientDnsRecords lists the CNAME, the apex's A record and the TXT", async () => {
    const { result, resources } = await prodWith([
      { hostname: 'www.client.com', zoneName: 'client.com' },
      { hostname: 'client.com', zoneName: 'client.com' },
    ]);
    expect([
      ofType(resources, 'cloudflare:index/dnsRecord:DnsRecord'),
      await valueOf(result.clientDnsRecords!),
      await valueOf(result.verification!),
    ]).toEqual([
      [],
      [
        { hostname: 'www.client.com', type: 'CNAME', name: 'www.client.com', value: 'cname.vercel-dns-017.com' },
        {
          hostname: 'www.client.com',
          type: 'TXT',
          name: '_vercel.client.com',
          value: TXT('client.com', 'www.client.com').value,
        },
        { hostname: 'client.com', type: 'A', name: 'client.com', value: '76.76.21.21' },
        {
          hostname: 'client.com',
          type: 'TXT',
          name: '_vercel.client.com',
          value: TXT('client.com', 'client.com').value,
        },
      ],
      { 'www.client.com': [TXT('client.com', 'www.client.com')], 'client.com': [TXT('client.com', 'client.com')] },
    ]);
  });

  test('outputs name the client records and the challenges, and stay empty of challenges once verified', async () => {
    const { result, resources } = await prodWith([NEW], {}, { 'new.pebbletech.my': true });
    expect([
      await valueOf(result.verification!),
      resources.find((r) => r.type === 'pebbletech:index:VercelProject')!.outputs,
    ]).toEqual([
      { 'new.pebbletech.my': [] },
      {
        projectId: 'prj_123',
        customEnvironmentIds: {},
        clientDnsRecords: [
          {
            hostname: 'new.pebbletech.my',
            type: 'CNAME',
            name: 'new.pebbletech.my',
            value: 'cname.vercel-dns-017.com',
          },
        ],
        verification: { 'new.pebbletech.my': [] },
      },
    ]);
  });

  // The record holds the value main passed, whatever Vercel lists now: verified with no challenge (on any release,
  // also the first, when Vercel verifies it mid-up), or not verified with no challenge at all.
  test.each<[string, Record<string, boolean>, pulumi.runtime.Mocks['newResource'] | undefined]>([
    ['verified, no challenge listed', { 'pebbletech.my': true }, undefined],
    [
      'unverified, no challenge listed',
      {},
      (args) => {
        const base = mocks().newResource(args) as { id: string; state: Record<string, any> };
        return { ...base, state: { ...base.state, verifications: [] } };
      },
    ],
  ])('makes the TXT from the value passed when the hostname is %s', async (_what, verified, newResource) => {
    const { resources } = await runProgram(
      {
        project: 'basefresh',
        stack: 'prod',
        mocks: { ...mocks(verified), ...(newResource ? { newResource } : {}) },
      },
      () => {
        const stage = new Stage('stage', { product: 'basefresh' });
        new VercelProject('web', { stage, projectId: 'prj_123', productionDomains: [APEX] });
      }
    );
    const txt = resources.find((r) => r.name === 'web-vercel-txt-pebbletech.my')!;
    expect([txt.inputs.content, txt.dependencies, txt.protect, txt.retainOnDelete]).toEqual([
      CHALLENGE,
      [],
      false,
      true,
    ]);
  });

  test('without the value there is no TXT record: leaving it out drops the record', async () => {
    const { resources } = await prodWith([{ ...APEX, verificationTxt: undefined }]);
    expect(resources.filter((r) => r.name.includes('vercel-txt'))).toEqual([]);
  });

  test.each(['', 'abc123', 'vc-domain-verify=pebbletech.my,abc 123', 'v=spf1 include:evil'])(
    'refuses %j as the TXT value',
    async (verificationTxt) => {
      await expect(prodWith([{ ...APEX, verificationTxt }])).rejects.toThrow("must be Vercel's challenge value");
    }
  );

  test('refuses a zone id whose zone is not the zone named', async () => {
    await expect(prodWith([{ ...NEW, zoneId: 'zone-2' }])).rejects.toThrow(
      'zone zone-2 is client.com, not pebbletech.my (hostname "new.pebbletech.my")'
    );
  });

  test.each(['staging', 'shared'])('refuses production domains on %s', async (stack) => {
    const extra = stack === 'staging' ? { customEnvironmentId: 'env_staging' } : {};
    await expect(prodWith([NEW], extra, undefined, stack)).rejects.toThrow(OwnershipError);
  });

  test.each([
    ['a stage-shaped hostname', { ...NEW, hostname: 'app-basefresh.pebbletech.my' }, /shaped like a stage hostname/],
    ["another stage's hostname", { ...NEW, hostname: 'app-basefresh-stg.pebbletech.my' }, /shaped like a stage/],
    ['a hostname outside its zone', { ...NEW, hostname: 'new.other.my' }, /not in the zone pebbletech.my/],
    ['a trailing dot', { ...NEW, hostname: 'new.pebbletech.my.' }, /not a lowercase domain name/],
    ['upper case', { ...NEW, hostname: 'New.pebbletech.my' }, /not a lowercase domain name/],
    ['a zone that is one label', { ...NEW, hostname: 'new.my', zoneName: 'my' }, /zone "my"/],
    [
      'the TXT with no zone of ours',
      { hostname: 'client.com', zoneName: 'client.com', verificationTxt: 'vc-domain-verify=client.com,abc123' },
      /pass it/,
    ],
  ])('refuses %s', async (_what, domain, message) => {
    await expect(prodWith([domain])).rejects.toThrow(message);
  });

  // A hostname named as its own zone, with no zoneId to check it against, must not slip a stage-shaped label past the
  // rule: each is a name inside the stage zone pebbletech.my.
  test.each(['app-other.pebbletech.my', 'app-other-stg.pebbletech.my', 'web-basefresh.pebbletech.my'])(
    'refuses %s named as its own zone in a client zone',
    async (hostname) => {
      await expect(prodWith([{ hostname, zoneName: hostname }])).rejects.toThrow(
        `zone "${hostname}" is a name inside the stage zone pebbletech.my`
      );
    }
  );

  test("refuses a zone inside the stage domain's own zone, which need not be pebbletech.my", async () => {
    const domain = { hostname: 'app-basefresh.example.dev', zoneId: 'zone-9' };
    await expect(
      prodWith([{ hostname: 'app-other.example.dev', zoneName: 'app-other.example.dev' }], { domain })
    ).rejects.toThrow('is a name inside the stage zone example.dev');
  });

  test("takes a client's hyphenated apex and a name in it", async () => {
    const { resources } = await prodWith([
      { hostname: 'my-client.com', zoneName: 'my-client.com' },
      { hostname: 'www.my-client.com', zoneName: 'my-client.com' },
    ]);
    expect(ofType(resources, 'vercel:index/projectDomain:ProjectDomain').map((r) => r.inputs.domain)).toEqual([
      'my-client.com',
      'www.my-client.com',
    ]);
  });

  test('refuses a hostname bound twice', async () => {
    await expect(prodWith([NEW, { ...NEW }])).rejects.toThrow('hostname "new.pebbletech.my" is bound twice');
  });
});

describe('VercelProject with a project-scoped Vercel token', () => {
  /** Fails the run on Vercel's domain config lookup, which a fixed CNAME target replaces. */
  const noLookup: pulumi.runtime.Mocks = {
    newResource: defaultMocks.newResource,
    call(args) {
      if (args.token === 'vercel:index/getDomainConfig:getDomainConfig') throw new Error('getDomainConfig was called');
      if (args.token === 'cloudflare:index/getZone:getZone') return { id: 'zone-1', name: 'pebbletech.my' };
      return defaultMocks.call(args);
    },
  };

  test.each(['staging', 'prod'])(
    '%s: cnameTarget points every CNAME at it with no lookup, and keeps every URN',
    async (stack) => {
      const args = {
        ...stageArgs(stack),
        ...(stack === 'prod'
          ? { productionDomains: [{ hostname: 'new.pebbletech.my', zoneName: 'pebbletech.my', zoneId: 'zone-1' }] }
          : {}),
      };
      const run = (mocks: pulumi.runtime.Mocks, extra: Partial<VercelProjectArgs>) =>
        runProgram({ project: 'basefresh', stack, mocks }, () => {
          const stage = new Stage('stage', { product: 'basefresh' });
          new VercelProject('web', { stage, ...args, ...extra });
        });
      const looked = await run(
        {
          ...noLookup,
          call: (a) =>
            a.token === 'vercel:index/getDomainConfig:getDomainConfig' ? defaultMocks.call(a) : noLookup.call(a),
        },
        {}
      );
      const fixed = await run(noLookup, { cnameTarget: 'cname.vercel-dns.com.' });
      const urns = (resources: Registration[]) => resources.map((r) => r.urn).sort();
      expect([
        urns(fixed.resources),
        ofType(fixed.resources, 'cloudflare:index/dnsRecord:DnsRecord').map((r) => r.inputs.content),
      ]).toEqual([
        urns(looked.resources),
        stack === 'prod' ? ['cname.vercel-dns.com', 'cname.vercel-dns.com'] : ['cname.vercel-dns.com'],
      ]);
    }
  );

  test("two projects in one stack each use their own Vercel provider; Cloudflare stays on the program's default", async () => {
    const { resources } = await runProgram({ project: 'basefresh', stack: 'prod', mocks: noLookup }, () => {
      const stage = new Stage('stage', { product: 'basefresh' });
      const marketing = new vercel.Provider('vercel-marketing', { apiToken: 'marketing-token', team: 'team_1' });
      const cms = new vercel.Provider('vercel-cms', { apiToken: 'cms-token', team: 'team_1' });
      const domain = (hostname: string) => ({ hostname, zoneId: 'zone-1' });
      new VercelProject(
        'site',
        {
          stage,
          projectId: 'prj_site',
          cnameTarget: 'cname.vercel-dns.com',
          domain: domain('site-basefresh.pebbletech.my'),
          vars: { A: 'a' },
        },
        { providers: [marketing] }
      );
      new VercelProject(
        'cms',
        {
          stage,
          projectId: 'prj_cms',
          cnameTarget: 'cname.vercel-dns.com',
          domain: domain('cms-basefresh.pebbletech.my'),
          vars: { A: 'a' },
        },
        { providers: [cms] }
      );
    });
    const providerOf = (r: Registration) => r.provider.split('::')[3] ?? '';
    expect(
      resources
        .filter((r) => r.custom && !r.type.startsWith('pulumi:providers:'))
        .map((r) => [r.name, providerOf(r)])
        .sort()
    ).toEqual([
      ['cms-cname', ''],
      ['cms-domain', 'vercel-cms'],
      ['cms-env-A', 'vercel-cms'],
      ['site-cname', ''],
      ['site-domain', 'vercel-marketing'],
      ['site-env-A', 'vercel-marketing'],
    ]);
  });
});
