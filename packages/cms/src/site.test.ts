import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  buildPreviewUrl,
  signPreview,
  signPurge,
  verifyPreview,
  verifyPurge,
  verifyPurgeRequest,
} from './site.js';

const secret = 'r'.repeat(40);
const now = new Date('2026-11-27T10:00:00Z');
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);

function purgeInput(signed: ReturnType<typeof signPurge>) {
  return {
    rawBody: signed.body,
    timestamp: signed.headers[TIMESTAMP_HEADER],
    signature: signed.headers[SIGNATURE_HEADER],
    secret,
  };
}

describe('purge signing', () => {
  test('the wire format is HMAC-SHA256 hex over `${ts}.${body}` with body {tags, ts}', () => {
    const signed = signPurge({ tags: ['collection:pages'], secret, now });
    const ts = Math.floor(now.getTime() / 1000);
    expect(signed.body).toBe(JSON.stringify({ tags: ['collection:pages'], ts }));
    expect(signed.headers).toEqual({
      'content-type': 'application/json',
      'x-pb-timestamp': String(ts),
      'x-pb-signature': createHmac('sha256', secret).update(`${ts}.${signed.body}`).digest('hex'),
    });
  });

  test('a fresh, untouched purge verifies and yields its tags', () => {
    const signed = signPurge({ tags: ['a', 'b'], secret, now });
    expect(verifyPurge({ ...purgeInput(signed), now: at(1) })).toEqual({ ok: true, tags: ['a', 'b'] });
  });

  test('a purge signed up to 5 minutes away either way verifies, and one second more is refused', () => {
    const signed = signPurge({ tags: ['a'], secret, now });
    expect(verifyPurge({ ...purgeInput(signed), now: at(300) }).ok).toBe(true);
    expect(verifyPurge({ ...purgeInput(signed), now: at(-300) }).ok).toBe(true);
    expect(verifyPurge({ ...purgeInput(signed), now: at(301) })).toEqual({
      ok: false,
      status: 401,
      reason: 'timestamp outside the window',
    });
    expect(verifyPurge({ ...purgeInput(signed), now: at(-301) })).toEqual({
      ok: false,
      status: 401,
      reason: 'timestamp outside the window',
    });
  });

  test('a replayed purge with a fresh timestamp header but the old signature is refused', () => {
    const signed = signPurge({ tags: ['a'], secret, now });
    const replay = { ...purgeInput(signed), timestamp: String(Math.floor(now.getTime() / 1000) + 600), now: at(600) };
    expect(verifyPurge(replay)).toMatchObject({ ok: false, status: 401, reason: 'bad signature' });
  });

  test('an altered body, an altered signature or another secret is refused', () => {
    const signed = signPurge({ tags: ['a'], secret, now });
    const input = { ...purgeInput(signed), now };
    expect(verifyPurge({ ...input, rawBody: signed.body.replace('"a"', '"b"') })).toMatchObject({
      reason: 'bad signature',
    });
    const flipped = (input.signature.startsWith('0') ? '1' : '0') + input.signature.slice(1);
    expect(verifyPurge({ ...input, signature: flipped })).toMatchObject({ reason: 'bad signature' });
    expect(verifyPurge({ ...input, secret: 's'.repeat(40) })).toMatchObject({ reason: 'bad signature' });
    expect(verifyPurge({ ...input, signature: undefined })).toMatchObject({ reason: 'bad signature' });
  });

  test('a body whose ts differs from the signed timestamp is refused even with a valid signature', () => {
    const ts = String(Math.floor(now.getTime() / 1000));
    const rawBody = JSON.stringify({ tags: ['a'], ts: 1 });
    const signature = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    expect(verifyPurge({ rawBody, timestamp: ts, signature, secret, now })).toMatchObject({
      ok: false,
      reason: 'body ts does not match the signed timestamp',
    });
  });

  test('without a configured secret nothing verifies', () => {
    const signed = signPurge({ tags: ['a'], secret, now });
    expect(verifyPurge({ ...purgeInput(signed), secret: undefined, now })).toEqual({
      ok: false,
      status: 500,
      reason: 'REVALIDATE_SECRET is not set',
    });
    expect(verifyPurge({ ...purgeInput(signed), secret: '', now }).ok).toBe(false);
    expect(() => signPurge({ tags: ['a'], secret: '' })).toThrow('REVALIDATE_SECRET is not set');
  });

  test('a malformed timestamp or an empty tag list is refused', () => {
    const signed = signPurge({ tags: [], secret, now });
    expect(verifyPurge({ ...purgeInput(signed), now })).toMatchObject({ ok: false, status: 400 });
    expect(verifyPurge({ ...purgeInput(signed), timestamp: '1e9', now })).toMatchObject({
      reason: 'missing or malformed timestamp',
    });
  });

  test('verifyPurgeRequest reads the headers and raw body of a Fetch request', async () => {
    const signed = signPurge({ tags: ['doc:pages:7'], secret });
    const request = new Request('https://site.example/api/revalidate', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    });
    await expect(verifyPurgeRequest(request, { secret })).resolves.toEqual({ ok: true, tags: ['doc:pages:7'] });
  });
});

describe('preview signing', () => {
  test('a preview link carries path, exp and an HMAC over `${path}.${exp}`, and verifies', () => {
    const url = new URL(buildPreviewUrl({ siteUrl: 'https://site.example', path: '/journey', secret, now }));
    const exp = Math.floor(now.getTime() / 1000) + 3600;
    expect(url.origin + url.pathname).toBe('https://site.example/preview');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: '/journey',
      exp: String(exp),
      sig: createHmac('sha256', secret).update(`/journey.${exp}`).digest('hex'),
    });
    expect(verifyPreview(url, { secret, now: at(60) })).toEqual({ ok: true, path: '/journey' });
  });

  test('an expired, re-pathed, over-long or unsigned link is refused', () => {
    const url = new URL(buildPreviewUrl({ siteUrl: 'https://site.example', path: '/a', secret, now }));
    expect(verifyPreview(url, { secret, now: at(3600) })).toEqual({ ok: false, reason: 'expired' });
    const moved = new URL(url);
    moved.searchParams.set('path', '/b');
    expect(verifyPreview(moved, { secret, now })).toEqual({ ok: false, reason: 'bad signature' });
    const far = new URL(
      buildPreviewUrl({ siteUrl: 'https://site.example', path: '/a', secret, now, ttlSeconds: 7200 })
    );
    expect(verifyPreview(far, { secret, now })).toEqual({ ok: false, reason: 'exp too far ahead' });
    expect(verifyPreview(url, { secret: undefined, now })).toEqual({ ok: false, reason: 'PREVIEW_SECRET is not set' });
  });

  test('only a site-relative path can be signed or verified', () => {
    expect(() => signPreview({ path: '//evil.example/x', secret })).toThrow('site-relative');
    expect(() => signPreview({ path: 'https://evil.example', secret })).toThrow('site-relative');
    const { exp, sig } = signPreview({ path: '/ok', secret, now });
    const forged = `https://site.example/preview?path=${encodeURIComponent('//evil.example')}&exp=${exp}&sig=${sig}`;
    expect(verifyPreview(forged, { secret, now })).toEqual({ ok: false, reason: 'bad path' });
  });
});
