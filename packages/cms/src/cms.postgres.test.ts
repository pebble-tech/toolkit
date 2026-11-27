import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPayload, handleEndpoints, type Payload, type SanitizedConfig } from 'payload';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  allowRoles,
  createCmsConfig,
  formatStampNotice,
  isStaff,
  livePreviewLink,
  notifySlackOnCreate,
  previewLink,
  publishedOrPreview,
  seedFirstAdmin,
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
      access: { read: () => true, create: allowRoles('stamp-submitter') },
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

    config = await createCmsConfig({
      databaseUrl: databaseUrl(DATABASE),
      collections: [pages, stamps],
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
  });
});
