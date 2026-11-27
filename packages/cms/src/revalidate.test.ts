import { expect, test } from 'vitest';

import { MAX_TAGS, sendPurge, verifyPurge } from './index.js';

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
