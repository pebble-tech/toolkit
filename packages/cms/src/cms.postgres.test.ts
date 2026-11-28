import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { getPayload, handleEndpoints, type Payload, type SanitizedConfig } from 'payload';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  createCmsConfig,
  formatStampNotice,
  isStaff,
  livePreviewLink,
  notifySlackOnCreate,
  previewLink,
  publishedOrPreview,
  seedFirstAdmin,
  submissionAccess,
  verifyPreview,
  verifyPurge,
  withRevalidateHooks,
} from './index.js';

// A real Payload on a real Postgres, driven through Payload's own REST handler (what apps/cms serves under /api).
// Only the external services are faked at their boundary: the marketing app's purge route is a local HTTP server and
// Slack is the injected fetch. R2 is never called: signing an upload URL needs no network. CI runs this against a
// Postgres service (verify.yml); without DATABASE_URL it fails in CI and is skipped elsewhere.

const skipped = !process.env.DATABASE_URL && !process.env.CI;
const skipReason = 'DATABASE_URL is unset: this test needs a local Postgres (CI runs it against a service)';
const DATABASE = `pebbletech_cms_test_${randomBytes(4).toString('hex')}`;
const REVALIDATE_SECRET = randomBytes(32).toString('hex');
const PREVIEW_SECRET = randomBytes(32).toString('hex');
const CAP = 1_000_000;
const ADMIN_EMAIL = 'admin@example.com';
const PASSWORD = randomBytes(12).toString('hex');

function databaseUrl(database: string): string {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is unset: CI must run this test against Postgres');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function sql<T extends pg.QueryResultRow>(database: string, query: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl(database) });
  await client.connect();
  try {
    return (await client.query<T>(query, values)).rows;
  } finally {
    await client.end();
  }
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let siteUrl: string;
const purges: Received[] = [];
const slackPosts: unknown[] = [];
let config: SanitizedConfig;
let payload: Payload;

async function api(
  path: string,
  init: { method?: string; body?: unknown; auth?: string } = {}
): Promise<{ status: number; json: any }> {
  const request = new Request(`http://localhost:3000/api${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.auth ? { authorization: init.auth } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const response = await handleEndpoints({ config, request });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

// R2 at its boundary: the AWS SDK's HTTPS request. Every PUT is answered 200 and recorded as the object key it writes.
function fakeR2(): { puts: string[]; restore: () => void } {
  const puts: string[] = [];
  const spy = vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, onResponse: never) => {
    const request = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
      final(done) {
        if (options.method === 'PUT') puts.push(String(options.path).split('?')[0]!);
        const response = Object.assign(Readable.from([]), { statusCode: 200, statusMessage: 'OK', headers: {} });
        (onResponse as (res: unknown) => void)(response);
        done();
      },
    });
    return Object.assign(request, { setTimeout: () => request, setNoDelay: () => {}, setSocketKeepAlive: () => {} });
  }) as never);
  syncBuiltinESMExports();
  return {
    puts,
    restore: () => {
      spy.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// Setup runs in beforeAll, where oxlint's vitest rules allow no expect: a failed step throws instead.
function setupStep(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

async function login(email: string, password: string): Promise<string> {
  const { status, json } = await api('/users/login', { method: 'POST', body: { email, password } });
  setupStep(status === 200, `login of ${email} answered ${status}`);
  return `JWT ${json.token}`;
}

describe.skipIf(skipped)(`@pebbletech/cms on Postgres${skipped ? ` (${skipReason})` : ''}`, () => {
  beforeAll(async () => {
    await sql('postgres', `CREATE DATABASE ${DATABASE}`);
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        purges.push({ headers: req.headers, body });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pagePath = (doc: Record<string, unknown>) => `/${String(doc.slug)}`;

    const pages = withRevalidateHooks(
      {
        slug: 'pages',
        versions: { drafts: true },
        access: { read: publishedOrPreview, create: isStaff, update: isStaff, delete: isStaff },
        admin: {
          preview: previewLink({ path: pagePath, siteUrl, secret: PREVIEW_SECRET }),
          livePreview: { url: livePreviewLink({ path: pagePath, siteUrl, secret: PREVIEW_SECRET }) },
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'slug', type: 'text' },
        ],
      },
      { siteUrl, secret: REVALIDATE_SECRET, bypassSecret: 'marketing-bypass' }
    );
    const stamps = {
      slug: 'stamps',
      access: submissionAccess('stamp-submitter'),
      hooks: {
        afterChange: [
          notifySlackOnCreate(
            (doc) =>
              formatStampNotice({
                stampUrl: 'https://media.example/s.png',
                note: doc.note as string,
                count: 1,
                createdAt: doc.createdAt as string,
                albumUrl: 'https://site.example/unstuck',
                removeUrl: `https://cms.example/admin/collections/stamps/${String(doc.id)}`,
                stage: 'staging',
              }),
            {
              webhookUrl: 'https://hooks.slack.com/services/test',
              fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
                slackPosts.push(JSON.parse(String(init?.body)));
                return new Response('ok');
              }) as typeof fetch,
            }
          ),
        ],
      },
      fields: [{ name: 'note', type: 'text' as const }],
    };

    const uploads = ['stamp-uploads', 'stamp-pngs'].map((slug) => ({
      slug,
      access: submissionAccess('stamp-submitter'),
      upload: { mimeTypes: ['image/png'] },
      fields: [],
    }));

    config = await createCmsConfig({
      databaseUrl: databaseUrl(DATABASE),
      collections: [pages, stamps, ...uploads],
      storageCollections: ['stamp-uploads', { slug: 'stamp-pngs', clientUploads: false }],
      serviceRoles: ['stamp-submitter'],
      maxUploadBytes: CAP,
      storage: {
        bucket: 'test-media',
        accountId: 'test-account',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        mediaBaseUrl: 'https://media.example',
      },
    });
    payload = await getPayload({ config });
  }, 120_000);

  afterAll(async () => {
    await payload?.destroy();
    const pool = (payload?.db as unknown as { pool?: { ended: boolean; end(): Promise<void> } } | undefined)?.pool;
    if (pool && !pool.ended) await pool.end();
    await new Promise((resolve) => server?.close(resolve));
    await sql('postgres', `DROP DATABASE IF EXISTS ${DATABASE}`);
  });

  test('every Payload table is in the cms schema and public stays empty', async () => {
    const rows = await sql<{ table_schema: string; table_name: string }>(
      DATABASE,
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('cms', 'public')`
    );
    expect(rows.filter((row) => row.table_schema === 'public')).toEqual([]);
    expect(rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(['users', 'media', 'pages', 'stamps']));
  });

  test('on an empty database nobody can register the first user, through the route or the Local API', async () => {
    const { status } = await api('/users/first-register', {
      method: 'POST',
      body: { email: 'attacker@example.com', password: PASSWORD, role: 'admin' },
    });
    expect(status).toBe(403);
    await expect(
      payload.create({ collection: 'users', data: { email: 'x@example.com', password: PASSWORD } as never })
    ).rejects.toThrow('You are not allowed to perform this action.');
    expect((await payload.count({ collection: 'users' })).totalDocs).toBe(0);
  });

  test('seedFirstAdmin creates the admin once; after that the route is still closed', async () => {
    await expect(seedFirstAdmin(payload, { email: ADMIN_EMAIL, password: 'short' })).rejects.toThrow('at least 12');
    await expect(seedFirstAdmin(payload, { email: ADMIN_EMAIL, password: PASSWORD })).resolves.toEqual({
      created: true,
    });
    await expect(seedFirstAdmin(payload, { email: 'other@example.com', password: PASSWORD })).resolves.toEqual({
      created: false,
    });
    // A later release job without the bootstrap credentials skips the seed instead of failing.
    vi.stubEnv('FIRST_ADMIN_EMAIL', '');
    vi.stubEnv('FIRST_ADMIN_PASSWORD', '');
    try {
      await expect(seedFirstAdmin(payload)).resolves.toEqual({ created: false });
    } finally {
      vi.unstubAllEnvs();
    }
    const { docs } = await payload.find({ collection: 'users' });
    expect(docs.map((user) => [user.email, (user as { role?: string }).role])).toEqual([[ADMIN_EMAIL, 'admin']]);
    const { status } = await api('/users/first-register', {
      method: 'POST',
      body: { email: 'late@example.com', password: PASSWORD },
    });
    expect(status).toBe(403);
  });

  describe('roles, API keys and access', () => {
    let adminAuth: string;
    let editorAuth: string;
    let editorId: number;
    const previewKey = randomBytes(24).toString('hex');
    const submitterKey = randomBytes(24).toString('hex');
    const previewAuth = `users API-Key ${previewKey}`;

    beforeAll(async () => {
      adminAuth = await login(ADMIN_EMAIL, PASSWORD);
      const editor = await api('/users', {
        method: 'POST',
        auth: adminAuth,
        body: { email: 'editor@example.com', password: PASSWORD, role: 'editor' },
      });
      setupStep(editor.status === 201, `creating the editor answered ${editor.status}`);
      editorId = editor.json.doc.id;
      editorAuth = await login('editor@example.com', PASSWORD);
      for (const [email, role, apiKey] of [
        ['preview@example.com', 'preview-reader', previewKey],
        ['stamps@example.com', 'stamp-submitter', submitterKey],
      ]) {
        const created = await api('/users', {
          method: 'POST',
          auth: adminAuth,
          body: { email, password: PASSWORD, role, enableAPIKey: true, apiKey },
        });
        setupStep(created.status === 201, `creating ${role} answered ${created.status}`);
      }
    });

    test('an admin or editor account cannot hold an API key', async () => {
      const { status, json } = await api('/users', {
        method: 'POST',
        auth: adminAuth,
        body: {
          email: 'keyed-editor@example.com',
          password: PASSWORD,
          role: 'editor',
          enableAPIKey: true,
          apiKey: 'k'.repeat(40),
        },
      });
      expect(status).toBe(400);
      expect(JSON.stringify(json)).toContain('Only these roles may hold an API key: preview-reader, stamp-submitter');
    });

    test('an editor cannot make themselves admin, and an anonymous caller cannot create users', async () => {
      await api(`/users/${editorId}`, { method: 'PATCH', auth: editorAuth, body: { role: 'admin' } });
      expect((await payload.findByID({ collection: 'users', id: editorId })).role).toBe('editor');
      const anonymous = await api('/users', {
        method: 'POST',
        body: { email: 'anon@example.com', password: PASSWORD },
      });
      expect(anonymous.status).toBe(403);
    });

    test('the preview reader can call the API with its key but cannot open the admin; an editor can', async () => {
      // Payload drops canAccessAdmin from the answer when it is false.
      expect((await api('/access', { auth: previewAuth })).json).not.toHaveProperty('canAccessAdmin');
      expect((await api('/access', { auth: editorAuth })).json.canAccessAdmin).toBe(true);
    });

    test('publishing purges the site with a signed, fresh request and the bypass header; a draft save does not', async () => {
      purges.length = 0;
      const draft = await api('/pages?draft=true', {
        method: 'POST',
        auth: editorAuth,
        body: { title: 'Hello', slug: 'hello', _status: 'draft' },
      });
      expect(draft.status).toBe(201);
      expect(purges).toEqual([]);

      const id = draft.json.doc.id;
      expect(
        (await api(`/pages/${id}`, { method: 'PATCH', auth: editorAuth, body: { _status: 'published' } })).status
      ).toBe(200);
      expect(purges).toHaveLength(1);
      const [purge] = purges as [Received];
      expect(purge.headers['x-vercel-protection-bypass']).toBe('marketing-bypass');
      const verified = verifyPurge({
        rawBody: purge.body,
        timestamp: purge.headers['x-pb-timestamp'] as string,
        signature: purge.headers['x-pb-signature'] as string,
        secret: REVALIDATE_SECRET,
      });
      expect(verified).toEqual({ ok: true, tags: ['collection:pages', `doc:pages:${id}`, 'doc:pages:hello'] });

      expect((await api(`/pages/${id}`, { method: 'DELETE', auth: editorAuth })).status).toBe(200);
      expect(purges).toHaveLength(2);
    });

    test('a slug too long for a cache tag is left out and the rest of the purge still verifies', async () => {
      purges.length = 0;
      const slug = 's'.repeat(300);
      const page = await api('/pages', { method: 'POST', auth: editorAuth, body: { slug, _status: 'published' } });
      expect(page.status).toBe(201);
      const [purge] = purges as [Received];
      expect(
        verifyPurge({
          rawBody: purge.body,
          timestamp: purge.headers['x-pb-timestamp'] as string,
          signature: purge.headers['x-pb-signature'] as string,
          secret: REVALIDATE_SECRET,
        })
      ).toEqual({ ok: true, tags: ['collection:pages', `doc:pages:${page.json.doc.id}`] });
      await api(`/pages/${page.json.doc.id}`, { method: 'DELETE', auth: editorAuth });
    });

    test('anonymous readers see only published pages; the preview reader sees drafts with its key', async () => {
      await api('/pages?draft=true', {
        method: 'POST',
        auth: editorAuth,
        body: { slug: 'draft-only', _status: 'draft' },
      });
      await api('/pages', { method: 'POST', auth: editorAuth, body: { slug: 'live', _status: 'published' } });
      const slugs = (res: { json: { docs: { slug: string }[] } }) => res.json.docs.map((doc) => doc.slug).sort();
      expect(slugs(await api('/pages'))).toEqual(['live']);
      expect(slugs(await api('/pages?draft=true', { auth: previewAuth }))).toEqual(['draft-only', 'live']);
    });

    test('the preview and live preview links are signed links the site verifies', async () => {
      const pages = config.collections.find((collection) => collection.slug === 'pages');
      const req = { payload } as never;
      const preview = await pages?.admin.preview?.({ slug: 'hello' }, { locale: 'en', req, token: null });
      const live = pages?.admin.livePreview?.url;
      const liveUrl =
        typeof live === 'function'
          ? await live({ data: { slug: 'hello' }, locale: { code: 'en', label: 'en' }, payload, req })
          : live;
      for (const url of [preview, liveUrl]) {
        expect(String(url).startsWith(`${siteUrl}/preview?`)).toBe(true);
        expect(verifyPreview(String(url), { secret: PREVIEW_SECRET })).toEqual({ ok: true, path: '/hello' });
      }
    });

    test('a signed upload URL is refused above the cap, and below it signs the exact content length', async () => {
      const sign = (filesize: number, auth: string) =>
        api('/storage-s3-generate-signed-url', {
          method: 'POST',
          auth,
          body: { collectionSlug: 'media', filename: 'photo.png', mimeType: 'image/png', filesize },
        });
      const over = await sign(CAP + 1, editorAuth);
      expect(over.status).toBe(400);
      expect(JSON.stringify(over.json)).toContain('Exceeded file size limit');

      const ok = await sign(1234, editorAuth);
      expect(ok.status).toBe(200);
      const url = new URL(ok.json.url);
      expect(url.hostname).toBe('test-media.test-account.r2.cloudflarestorage.com');
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
      expect(ok.json.headers['Content-Length']).toBe('1234');

      expect((await sign(1234, previewAuth)).status).toBe(403);
    });

    test('a signed browser upload is refused for a type media does not list, such as HTML or SVG', async () => {
      for (const [filename, mimeType] of [
        ['x.html', 'text/html'],
        ['x.svg', 'image/svg+xml'],
        ['x.png', 'application/octet-stream'],
      ]) {
        const signed = await api('/storage-s3-generate-signed-url', {
          method: 'POST',
          auth: editorAuth,
          body: { collectionSlug: 'media', filename, mimeType, filesize: 100 },
        });
        expect(signed.status).toBe(400);
        expect(JSON.stringify(signed.json)).toContain('is not allowed for media');
      }
    });

    test('a create-only key gets a signed URL for a listed storage collection, but never for one that opted out', async () => {
      const sign = (collectionSlug: string, auth: string, mimeType = 'image/png') =>
        api('/storage-s3-generate-signed-url', {
          method: 'POST',
          auth,
          body: { collectionSlug, filename: 'stamp.png', mimeType, filesize: 100 },
        });
      const submitterAuth = `users API-Key ${submitterKey}`;
      const listed = await sign('stamp-uploads', submitterAuth);
      expect(listed.status).toBe(200);
      expect(new URL(listed.json.url).hostname).toBe('test-media.test-account.r2.cloudflarestorage.com');
      expect((await sign('stamp-uploads', submitterAuth, 'text/html')).status).toBe(400);

      for (const auth of [submitterAuth, editorAuth, adminAuth]) {
        const refused = await sign('stamp-pngs', auth);
        expect(refused.status).toBe(403);
        expect(JSON.stringify(refused.json)).toContain('does not accept signed browser uploads');
        expect(refused.json.url).toBeUndefined();
      }
    });

    test('a signed key always carries a random segment and never overwrites, so it cannot hit a server-only collection file', async () => {
      // A server-side upload to an opted-out collection stores `<filename>` at the bucket root (no collection prefix).
      const serverOnlyKey = '/stamp.png';
      const attempts = [
        { filename: 'stamp.png' },
        { filename: '../stamp.png' },
        { filename: '/stamp.png', docPrefix: '../..' },
        { filename: 'stamp.png', docPrefix: '' },
      ];
      for (const attempt of attempts) {
        const signed = await api('/storage-s3-generate-signed-url', {
          method: 'POST',
          auth: `users API-Key ${submitterKey}`,
          body: { collectionSlug: 'stamp-uploads', mimeType: 'image/png', filesize: 100, ...attempt },
        });
        expect(signed.status).toBe(200);
        const key = new URL(signed.json.url).pathname;
        expect(key).toMatch(/^\/([^/]+\/)*[0-9a-f-]{36}\/stamp\.png$/);
        expect(key).not.toBe(serverOnlyKey);
        expect(signed.json.headers['If-None-Match']).toBe('*');
        expect(new URL(signed.json.url).searchParams.get('X-Amz-SignedHeaders')).toContain('if-none-match');
      }
    });

    test('a create-only upload to a storage collection can never write a media object, whatever its name or prefix', async () => {
      const upload = async (collection: string, auth: string, fields: Record<string, unknown>) => {
        const form = new FormData();
        form.append('file', new Blob([PNG], { type: 'image/png' }), 'photo.png');
        form.append('_payload', JSON.stringify(fields));
        const response = await handleEndpoints({
          config,
          request: new Request(`http://localhost:3000/api/${collection}`, {
            method: 'POST',
            headers: { authorization: auth },
            body: form,
          }),
        });
        return { status: response.status, json: JSON.parse(await response.text()) };
      };
      const r2 = fakeR2();
      try {
        const media = await upload('media', editorAuth, { alt: 'public' });
        expect(media.status).toBe(201);
        const mediaKey = r2.puts.at(-1);
        expect(mediaKey).toBe('/photo.png');

        // The first is a plain upload. The others try to steer the key with a prefix; where the collection has no
        // prefix field Payload refuses them, so only the keys that were written are asserted.
        const plain = await upload('stamp-pngs', `users API-Key ${submitterKey}`, {});
        expect(plain.status).toBe(201);
        // Media keeps its URL; the opted-out collection's URLs carry its folder.
        expect(media.json.doc.url).toBe('https://media.example/photo.png');
        expect(plain.json.doc.url).toBe('https://media.example/stamp-pngs/photo.png');
        for (const fields of [{ prefix: media.json.doc.prefix ?? '' }, { prefix: '../' }, { prefix: '/x/../y' }]) {
          await upload('stamp-pngs', `users API-Key ${submitterKey}`, fields);
        }
        expect(r2.puts.filter((key) => key === mediaKey)).toHaveLength(1);
        expect(r2.puts.slice(1).every((key) => key.startsWith('/stamp-pngs/'))).toBe(true);
        expect(r2.puts.length).toBeGreaterThan(1);
      } finally {
        r2.restore();
      }
    });

    test('media refuses even a harmless SVG uploaded through the CMS', async () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'], {
          type: 'image/svg+xml',
        }),
        'x.svg'
      );
      form.append('_payload', JSON.stringify({ alt: 'x' }));
      const request = new Request('http://localhost:3000/api/media', {
        method: 'POST',
        headers: { authorization: editorAuth },
        body: form,
      });
      const response = await handleEndpoints({ config, request });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Invalid MIME type: image/svg+xml');
    });

    test('media URLs are built from MEDIA_BASE_URL when read, not stored', async () => {
      const doc = await payload.db.create({
        collection: 'media',
        data: { alt: 'a', filename: 'a b.png', mimeType: 'image/png', filesize: 10 },
      });
      const stored = await sql<{ url: string | null }>(DATABASE, 'SELECT url FROM cms.media WHERE id = $1', [doc.id]);
      expect(stored).toEqual([{ url: null }]);
      expect((await payload.findByID({ collection: 'media', id: doc.id })).url).toBe('https://media.example/a%20b.png');
    });

    test('a service key creates a stamp and Slack gets one postcard notice; an update posts nothing', async () => {
      slackPosts.length = 0;
      const auth = `users API-Key ${submitterKey}`;
      const created = await api('/stamps', { method: 'POST', auth, body: { note: 'hi' } });
      expect(created.status).toBe(201);
      await payload.update({ collection: 'stamps', id: created.json.doc.id, data: { note: 'edited' } });
      expect(slackPosts).toHaveLength(1);
      expect(JSON.stringify(slackPosts[0])).toContain('[staging] :love_letter: *A postcard just landed!*');
    });

    test('a submissions collection: the service key may only create, staff read, and nothing is public', async () => {
      const auth = `users API-Key ${submitterKey}`;
      const created = await api('/stamps', { method: 'POST', auth, body: { note: 'second' } });
      expect(created.status).toBe(201);
      const id = created.json.doc.id;
      expect((await api('/stamps')).status).toBe(403);
      expect((await api(`/stamps/${id}`)).status).toBe(403);
      expect((await api('/stamps', { auth })).status).toBe(403);
      expect((await api(`/stamps/${id}`, { auth })).status).toBe(403);
      expect((await api('/stamps', { auth: previewAuth })).status).toBe(403);
      expect((await api(`/stamps/${id}`, { method: 'PATCH', auth, body: { note: 'changed' } })).status).toBe(403);
      expect((await api(`/stamps/${id}`, { method: 'DELETE', auth })).status).toBe(403);
      expect((await api('/stamps', { method: 'POST', body: { note: 'anonymous' } })).status).toBe(403);
      expect((await api('/stamps', { auth: editorAuth })).json.totalDocs).toBe(2);
    });
  });
});
