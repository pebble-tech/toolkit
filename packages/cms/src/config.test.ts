import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_MAX_UPLOAD_BYTES, createCmsConfig } from './index.js';

const strong = 'p'.repeat(40);
const r2 = { bucket: 'bfa-media', accountId: 'acct', accessKeyId: 'AKID', secretAccessKey: 'shh' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PAYLOAD_SECRET', () => {
  test.each(['production', 'staging', ''])('NODE_ENV=%j refuses to start with no secret', async (env) => {
    vi.stubEnv('NODE_ENV', env);
    vi.stubEnv('PAYLOAD_SECRET', '');
    expect(() => createCmsConfig({ storage: r2 })).toThrow(
      'PAYLOAD_SECRET must be set to a generated value of at least 32 characters'
    );
  });

  test('production refuses a short secret, such as the skeleton fallback literal', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYLOAD_SECRET', 'dev-only-secret-change-in-production');
    expect(() => createCmsConfig({ storage: r2 })).toThrow('PAYLOAD_SECRET must be set');
  });

  test('production uses the secret it is given', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYLOAD_SECRET', strong);
    expect((await createCmsConfig({ storage: r2 })).secret).toBe(strong);
  });

  test('development and test with no secret get a random one per start, never a fixed value', async () => {
    vi.stubEnv('PAYLOAD_SECRET', '');
    vi.stubEnv('NODE_ENV', 'development');
    const first = (await createCmsConfig()).secret;
    vi.stubEnv('NODE_ENV', 'test');
    const second = (await createCmsConfig()).secret;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe('R2 storage', () => {
  test('production refuses to start without the R2 settings, naming the missing ones', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYLOAD_SECRET', strong);
    vi.stubEnv('R2_BUCKET', 'bfa-media');
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) vi.stubEnv(name, '');
    expect(() => createCmsConfig()).toThrow('R2 storage needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  });

  test('with R2 configured, media gets the signed browser-upload endpoint', async () => {
    const config = await createCmsConfig({ storage: r2 });
    expect(config.endpoints.map((endpoint) => endpoint.path)).toContain('/storage-s3-generate-signed-url');
  });
});

describe('storageCollections', () => {
  const uploadCollection = (slug: string) => ({ slug, upload: true, fields: [] });
  const clientUploadSlugs = (config: Awaited<ReturnType<typeof createCmsConfig>>) =>
    ((config.admin.components?.providers ?? []) as { clientProps?: { collectionSlug?: string } }[])
      .map((provider) => provider.clientProps?.collectionSlug)
      .filter(Boolean);

  test('a plain slug gets browser uploads like media; one that opts out is uploaded through the CMS only', async () => {
    const config = await createCmsConfig({
      storage: r2,
      collections: [uploadCollection('plain'), uploadCollection('server-only')],
      storageCollections: ['plain', { slug: 'server-only', clientUploads: false }],
    });
    expect(clientUploadSlugs(config)).toEqual(['media', 'plain']);
    expect(
      config.endpoints.filter((endpoint) => endpoint.path?.startsWith('/storage-s3-generate-signed-url'))
    ).toHaveLength(1);
    const stored = (slug: string) => config.collections.find((collection) => collection.slug === slug)?.upload;
    expect(stored('server-only')).toMatchObject({ disableLocalStorage: true });
  });
});

describe('shape', () => {
  test('types are written with declare: false; locales default to en; uploads cap at 10 MB', async () => {
    const config = await createCmsConfig({ typesOutputFile: '/tmp/payload-types.ts' });
    expect(config.typescript).toMatchObject({
      autoGenerate: false,
      declare: false,
      outputFile: '/tmp/payload-types.ts',
    });
    expect(config.localization).toMatchObject({ defaultLocale: 'en', localeCodes: ['en'], fallback: true });
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(config.upload.limits?.fileSize).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(config.admin.user).toBe('users');
  });

  test('locales, the upload cap and the client collections are options', async () => {
    const config = await createCmsConfig({
      locales: ['en', 'ms', 'zh'],
      maxUploadBytes: 1024,
      collections: [{ slug: 'products', fields: [{ name: 'sku', type: 'text' }] }],
    });
    expect(config.localization).toMatchObject({ defaultLocale: 'en', localeCodes: ['en', 'ms', 'zh'] });
    expect(config.upload.limits?.fileSize).toBe(1024);
    expect(config.collections.map((collection) => collection.slug).slice(0, 3)).toEqual(['users', 'media', 'products']);
  });

  test('importMapBaseDir keeps the other admin.importMap settings it is given', async () => {
    const config = await createCmsConfig({
      importMapBaseDir: '/app/src',
      admin: { importMap: { importMapFile: '/app/src/app/(payload)/admin/importMap.js' } },
    });
    expect(config.admin.importMap).toMatchObject({
      baseDir: '/app/src',
      importMapFile: '/app/src/app/(payload)/admin/importMap.js',
    });
  });

  test('a cap that is not a positive whole number of bytes is refused', () => {
    expect(() => createCmsConfig({ maxUploadBytes: 0 })).toThrow('maxUploadBytes');
    expect(() => createCmsConfig({ maxUploadBytes: Number.POSITIVE_INFINITY })).toThrow('maxUploadBytes');
  });

  test('a service role may not reuse a base role name', () => {
    expect(() => createCmsConfig({ serviceRoles: ['admin'] })).toThrow(
      'serviceRoles may not repeat a base role: admin'
    );
  });
});
