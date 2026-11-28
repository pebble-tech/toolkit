import type { PayloadRequest } from 'payload';
import { expect, test } from 'vitest';

import { MAX_TAGS, sendPurge, verifyPurge, withRevalidateHooks } from './index.js';
import type { PurgeGiveUp, RevalidateOptions } from './index.js';

const secret = 'r'.repeat(40);

// The marketing app is the external service; the fake stands at its boundary, the fetch call.
function fakeSite() {
  const bodies: { body: string; headers: Record<string, string> }[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push({ body: String(init?.body), headers: init?.headers as Record<string, string> });
    return new Response('{}');
  };
  return { bodies, fetch: fetch as typeof globalThis.fetch };
}

test('more tags than one purge may carry go as several signed purges, each one the receiver accepts', async () => {
  const site = fakeSite();
  const tags = Array.from({ length: MAX_TAGS * 2 + 5 }, (_, i) => `doc:pages:${i}`);
  await sendPurge(tags, { siteUrl: 'https://site.example', secret, fetch: site.fetch });
  const received = site.bodies.map(({ body, headers }) =>
    verifyPurge({ rawBody: body, timestamp: headers['x-pb-timestamp'], signature: headers['x-pb-signature'], secret })
  );
  expect(received.map((result) => (result.ok ? result.tags.length : result.reason))).toEqual([MAX_TAGS, MAX_TAGS, 5]);
  expect(received.flatMap((result) => (result.ok ? result.tags : []))).toEqual(tags);
});

// A site that answers each request with the next scripted reply: a status, or an Error for a network failure.
function scriptedSite(replies: (number | Error)[]) {
  const sent: { tags: string[]; ts: string; signature: string }[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    sent.push({
      tags: (JSON.parse(String(init?.body)) as { tags: string[] }).tags,
      ts: headers['x-pb-timestamp'],
      signature: headers['x-pb-signature'],
    });
    const reply = replies[sent.length - 1] ?? 200;
    if (reply instanceof Error) throw reply;
    return new Response('{}', { status: reply });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

function retrying(site: { fetch: typeof globalThis.fetch }, delays: number[] = []) {
  return {
    siteUrl: 'https://site.example',
    secret,
    fetch: site.fetch,
    attempts: 3,
    random: () => 1,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

function hookRun(options: RevalidateOptions) {
  const logged: { obj: Record<string, unknown>; msg: string }[] = [];
  const req = {
    payload: { logger: { error: (obj: Record<string, unknown>, msg: string) => logged.push({ obj, msg }) } },
  } as unknown as PayloadRequest;
  const hook = withRevalidateHooks({ slug: 'pages', fields: [] }, options).hooks!.afterChange![0]!;
  const run = () => hook({ doc: { id: 1, slug: 'home' }, previousDoc: {}, req } as never);
  return { logged, run };
}

test('a purge answered 500 and then 200 is sent again and ends done, the batch once accepted', async () => {
  const site = scriptedSite([500, 200]);
  await sendPurge(['a', 'b'], retrying(site));
  expect(site.sent.map((s) => s.tags)).toEqual([
    ['a', 'b'],
    ['a', 'b'],
  ]);
});

test('a network error and then success ends done', async () => {
  const site = scriptedSite([new TypeError('fetch failed'), 200]);
  await sendPurge(['a'], retrying(site));
  expect(site.sent).toHaveLength(2);
});

test('a 429 and then success ends done', async () => {
  const site = scriptedSite([429, 200]);
  await sendPurge(['a'], retrying(site));
  expect(site.sent).toHaveLength(2);
});

test('sendPurge without attempts tries once, as before', async () => {
  const site = scriptedSite([500, 200]);
  await expect(sendPurge(['a'], { siteUrl: 'https://site.example', secret, fetch: site.fetch })).rejects.toThrow(
    'purge answered 500'
  );
  expect(site.sent).toHaveLength(1);
});

test('401, 403 and 400 are not retried and fail at once with the status', async () => {
  for (const status of [400, 401, 403]) {
    const site = scriptedSite([status, 200]);
    const error = await sendPurge(['a'], retrying(site)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'PurgeError', status, attempts: 1, tags: ['a'] });
    expect(site.sent).toHaveLength(1);
  }
});

test('each attempt is signed afresh and the receiver accepts the retried purge', async () => {
  const site = scriptedSite([503, 200]);
  await sendPurge(['a'], retrying(site));
  expect(site.sent[0]!.ts).toMatch(/^\d+$/);
  const retry = site.sent[1]!;
  expect(
    verifyPurge({
      rawBody: JSON.stringify({ tags: retry.tags, ts: Number(retry.ts) }),
      timestamp: retry.ts,
      signature: retry.signature,
      secret,
    }).ok
  ).toBe(true);
});

test('only the failed batch is retried; batches already accepted are not sent again', async () => {
  const site = scriptedSite([200, 500, 200, 200]);
  const tags = Array.from({ length: MAX_TAGS * 3 }, (_, i) => `doc:pages:${i}`);
  await sendPurge(tags, retrying(site));
  expect(site.sent.map((s) => s.tags[0])).toEqual([
    'doc:pages:0',
    `doc:pages:${MAX_TAGS}`,
    `doc:pages:${MAX_TAGS}`,
    `doc:pages:${MAX_TAGS * 2}`,
  ]);
});

test('backoff grows with each retry and stops at the cap; jitter stays between half and all of it', async () => {
  const delays: number[] = [];
  const site = scriptedSite([500, 500, 500, 500, 500, 500]);
  await sendPurge(['a'], { ...retrying(site, delays), attempts: 6 }).catch(() => undefined);
  expect(delays).toEqual([250, 500, 1000, 2000, 2000]);

  const low: number[] = [];
  await sendPurge(['a'], { ...retrying(scriptedSite([500, 500]), low), random: () => 0 });
  expect(low).toEqual([125, 250]);
});

test('a purge that exhausts its attempts gives up: logged, onGiveUp called, nothing thrown out of the hook', async () => {
  const site = scriptedSite([500, 502, 503]);
  const given: PurgeGiveUp[] = [];
  const { logged, run } = hookRun({ ...retrying(site), onGiveUp: (info) => void given.push(info) });
  await expect(run()).resolves.toEqual({ id: 1, slug: 'home' });
  expect(site.sent).toHaveLength(3);
  expect(logged).toHaveLength(1);
  expect(logged[0]!.msg).toBe('cache purge failed');
  expect(logged[0]!.obj).toMatchObject({
    attempts: 3,
    status: 503,
    tags: expect.arrayContaining(['collection:pages']),
  });
  expect(given).toHaveLength(1);
  expect(given[0]).toMatchObject({ attempts: 3, error: { status: 503 } });
  expect(given[0]!.tags).toEqual(logged[0]!.obj.tags);
});

test('an onGiveUp that throws neither fails the hook nor hides the purge failure', async () => {
  const { logged, run } = hookRun({
    ...retrying(scriptedSite([401])),
    onGiveUp: () => {
      throw new Error('boom');
    },
  });
  await expect(run()).resolves.toEqual({ id: 1, slug: 'home' });
  expect(logged.map((l) => l.msg)).toEqual(['cache purge failed', 'cache purge onGiveUp failed']);
});

test('the hook retries a transient failure by default and ends with the purge done, nothing logged', async () => {
  const site = scriptedSite([500, 200]);
  const { attempts: _attempts, ...withoutAttempts } = retrying(site);
  const { logged, run } = hookRun(withoutAttempts);
  await run();
  expect(site.sent).toHaveLength(2);
  expect(logged).toEqual([]);
});
