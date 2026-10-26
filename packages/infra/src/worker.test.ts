import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { NamespaceError, OwnershipError, PlainTextSecretError, Stage, Worker, type WorkerArgs } from './index.js';
import { runProgram } from './testing.js';

const BUNDLE = 'export default { fetch() { return new Response("ok"); } };\n';
const script = join(mkdtempSync(join(tmpdir(), 'pebbletech-infra-worker-')), 'server.js');
writeFileSync(script, BUNDLE);

async function workerIn(stack: string, args: Partial<Omit<WorkerArgs, 'stage'>> = {}) {
  return runProgram({ project: 'basefresh', stack }, () => {
    const stage = new Stage('stage', { product: 'basefresh' });
    return new Worker('uploads', {
      stage,
      accountId: 'account-1',
      zoneId: 'zone-1',
      script,
      compatibilityDate: '2025-04-01',
      compatibilityFlags: ['nodejs_compat'],
      hostname: stage.hostname('uploads', 'pebbletech.my'),
      kind: 'uploads',
      bucket: { binding: 'UploadsBucket' },
      vars: { UPLOAD_ALLOWED_ORIGINS: 'https://app-basefresh-stg.pebbletech.my' },
      secrets: { DATABASE_URL: 'postgresql://u:p@h:6432/db', BETTER_AUTH_SECRET: 'shh' },
      ...args,
    });
  });
}

const byType = (resources: { type: string }[], type: string) => resources.filter((r) => r.type === type) as any[];

describe('Worker', () => {
  test('creates the script, its R2 bucket and its custom domain, named from the stage', async () => {
    const { resources } = await workerIn('staging');
    const children = resources.filter((r) => r.parent.endsWith('pebbletech:index:Worker::uploads'));
    expect(children.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      'cloudflare:index/r2Bucket:R2Bucket uploads-bucket',
      'cloudflare:index/workersCustomDomain:WorkersCustomDomain uploads-domain',
      'cloudflare:index/workersScript:WorkersScript uploads',
    ]);
    expect(byType(resources, 'cloudflare:index/r2Bucket:R2Bucket')[0].inputs).toMatchObject({
      accountId: 'account-1',
      name: 'basefresh-staging-uploads',
    });
    expect(byType(resources, 'cloudflare:index/workersCustomDomain:WorkersCustomDomain')[0].inputs).toMatchObject({
      hostname: 'uploads-basefresh-stg.pebbletech.my',
      zoneId: 'zone-1',
      service: 'basefresh-staging-uploads',
    });
  });

  test.each([
    ['staging', 'uploads-basefresh-stg.pebbletech.my'],
    ['prod', 'uploads-basefresh.pebbletech.my'],
  ])(
    '%s replaces the custom domain delete-first, and nothing else: its hostname is unique',
    async (stack, hostname) => {
      expect.assertions(1);
      const { resources } = await workerIn(stack, { hostname });
      expect(resources.filter((r) => r.deleteBeforeReplace).map((r) => `${r.type} ${r.name}`)).toEqual([
        'cloudflare:index/workersCustomDomain:WorkersCustomDomain uploads-domain',
      ]);
    }
  );

  test('the script uploads the bundle as a module, with its hash, flags and bindings', async () => {
    const { resources } = await workerIn('staging');
    const worker = byType(resources, 'cloudflare:index/workersScript:WorkersScript')[0];
    expect(worker.inputs).toMatchObject({
      scriptName: 'basefresh-staging-uploads',
      contentFile: script,
      contentSha256: createHash('sha256').update(BUNDLE).digest('hex'),
      mainModule: 'server.js',
      compatibilityDate: '2025-04-01',
      compatibilityFlags: ['nodejs_compat'],
    });
    expect(worker.inputs.bindings).toEqual([
      { type: 'r2_bucket', name: 'UploadsBucket', bucketName: 'basefresh-staging-uploads' },
      { type: 'plain_text', name: 'UPLOAD_ALLOWED_ORIGINS', text: 'https://app-basefresh-stg.pebbletech.my' },
      { type: 'secret_text', name: 'DATABASE_URL', text: 'postgresql://u:p@h:6432/db' },
      { type: 'secret_text', name: 'BETTER_AUTH_SECRET', text: 'shh' },
    ]);
    expect(worker.secretInputs).toEqual(['bindings']);
  });

  test('adoptExisting on prod imports the stage-named bucket, and only then', async () => {
    const adopted = await workerIn('prod', {
      hostname: 'uploads-basefresh.pebbletech.my',
      bucket: { binding: 'UploadsBucket', adoptExisting: true },
    });
    const bucket = byType(adopted.resources, 'cloudflare:index/r2Bucket:R2Bucket')[0];
    expect([bucket.inputs.name, bucket.importId]).toEqual([
      'basefresh-prod-uploads',
      'account-1/basefresh-prod-uploads/default',
    ]);
    const created = await workerIn('prod', { hostname: 'uploads-basefresh.pebbletech.my' });
    const fresh = byType(created.resources, 'cloudflare:index/r2Bucket:R2Bucket')[0];
    expect([fresh.inputs.name, fresh.importId]).toEqual(['basefresh-prod-uploads', '']);
  });

  test("a preview cannot adopt another bucket by name (the reviewer's probe)", async () => {
    const { resources } = await workerIn('pr-7', {
      hostname: 'uploads-basefresh-pr-7.pebbletech.my',
      bucket: { binding: 'UploadsBucket', importBucket: 'prod-legacy-bucket' },
    } as never);
    const bucket = byType(resources, 'cloudflare:index/r2Bucket:R2Bucket')[0];
    expect([bucket.inputs.name, bucket.importId]).toEqual(['basefresh-pr-7-uploads', '']);
  });

  test.each([
    ['pr-7', 'uploads-basefresh-pr-7.pebbletech.my'],
    ['staging', 'uploads-basefresh-stg.pebbletech.my'],
  ])('%s refuses to adopt an existing bucket', async (stack, hostname) => {
    await expect(
      workerIn(stack, { hostname, bucket: { binding: 'UploadsBucket', adoptExisting: true } })
    ).rejects.toThrow(OwnershipError);
  });

  test('on prod every child is protected and retained', async () => {
    const { resources } = await workerIn('prod', { hostname: 'uploads-basefresh.pebbletech.my' });
    const children = resources.filter((r) => r.custom);
    expect(children).toHaveLength(3);
    expect(children.filter((r) => !r.protect || !r.retainOnDelete)).toEqual([]);
  });

  test('outputs are registered', async () => {
    const { resources } = await workerIn('staging');
    expect(resources.find((r) => r.type === 'pebbletech:index:Worker')!.outputs).toEqual({
      scriptName: 'basefresh-staging-uploads',
      bucketName: 'basefresh-staging-uploads',
      hostname: 'uploads-basefresh-stg.pebbletech.my',
      url: 'https://uploads-basefresh-stg.pebbletech.my',
    });
  });

  test.each(['DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_TOKEN', 'DB_PASSWORD', 'STRIPE_API_KEY'])(
    'refuses %s as a plain-text var',
    async (key) => {
      await expect(workerIn('staging', { vars: { [key]: 'value' } })).rejects.toThrow(PlainTextSecretError);
    }
  );

  test('a var marked in plainTextAllowed is bound as plain text', async () => {
    const { resources } = await workerIn('staging', {
      vars: { SIGNING_PUBLIC_KEY: 'pk' },
      plainTextAllowed: ['SIGNING_PUBLIC_KEY'],
    });
    const worker = byType(resources, 'cloudflare:index/workersScript:WorkersScript')[0];
    expect(worker.inputs.bindings).toContainEqual({ type: 'plain_text', name: 'SIGNING_PUBLIC_KEY', text: 'pk' });
  });

  test("refuses another stage's hostname", async () => {
    await expect(workerIn('staging', { hostname: 'uploads-basefresh.pebbletech.my' })).rejects.toThrow(NamespaceError);
  });

  test('refuses the shared stack', async () => {
    await expect(workerIn('shared', { hostname: 'uploads-basefresh.pebbletech.my' })).rejects.toThrow(OwnershipError);
  });
});
