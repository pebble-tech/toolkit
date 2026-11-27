// The site side of the wire between the CMS and the marketing app: signed purge, signed preview links and cache tags.
// This module imports nothing but node:crypto, so apps/marketing can use it without Payload, Next.js or a database.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_HEADER = 'x-pb-timestamp';
export const SIGNATURE_HEADER = 'x-pb-signature';
/** Vercel's protection bypass header; each project holds the other project's bypass secret. */
export const VERCEL_BYPASS_HEADER = 'x-vercel-protection-bypass';
/** How far a purge's signed timestamp may be from the receiver's clock, either way. */
export const PURGE_WINDOW_SECONDS = 300;
export const PREVIEW_TTL_SECONDS = 3600;
export const SITE_CACHE_TAG = 'site';

export const MAX_TAGS = 128;
export const MAX_TAG_LENGTH = 256;

export function collectionTag(slug: string): string {
  return `collection:${slug}`;
}

export function docTag(slug: string, idOrSlug: string | number): string {
  return `doc:${slug}:${idOrSlug}`;
}

export function globalTag(slug: string): string {
  return `global:${slug}`;
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

function sameHex(expected: string, provided: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

function requireSecret(secret: string | undefined, name: string): string {
  if (!secret) throw new Error(`${name} is not set`);
  return secret;
}

function unixSeconds(now: Date | undefined): number {
  return Math.floor((now ?? new Date()).getTime() / 1000);
}

export interface SignedPurge {
  /** The exact bytes to send as the request body. */
  body: string;
  headers: Record<string, string>;
}

/** Signs a purge: body `{tags, ts}`, signature HMAC-SHA256 hex over `${ts}.${body}`. */
export function signPurge(options: { tags: string[]; secret: string; now?: Date }): SignedPurge {
  const secret = requireSecret(options.secret, 'REVALIDATE_SECRET');
  const ts = unixSeconds(options.now);
  const body = JSON.stringify({ tags: options.tags, ts });
  return {
    body,
    headers: {
      'content-type': 'application/json',
      [TIMESTAMP_HEADER]: String(ts),
      [SIGNATURE_HEADER]: hmacHex(secret, `${ts}.${body}`),
    },
  };
}

export type PurgeVerification = { ok: true; tags: string[] } | { ok: false; status: 400 | 401 | 500; reason: string };

export interface VerifyPurgeInput {
  rawBody: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  secret: string | undefined;
  now?: Date;
  /** Defaults to PURGE_WINDOW_SECONDS. */
  windowSeconds?: number;
}

/**
 * Checks a purge the way `/api/revalidate` must: secret configured, timestamp within the window, HMAC over
 * `${ts}.${rawBody}` (constant-time), the body's `ts` equal to the signed header, and a non-empty list of tags.
 */
export function verifyPurge(input: VerifyPurgeInput): PurgeVerification {
  if (!input.secret) return { ok: false, status: 500, reason: 'REVALIDATE_SECRET is not set' };
  const timestamp = input.timestamp ?? '';
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, status: 401, reason: 'missing or malformed timestamp' };
  const ts = Number(timestamp);
  const window = input.windowSeconds ?? PURGE_WINDOW_SECONDS;
  if (Math.abs(unixSeconds(input.now) - ts) > window) {
    return { ok: false, status: 401, reason: 'timestamp outside the window' };
  }
  const expected = hmacHex(input.secret, `${timestamp}.${input.rawBody}`);
  if (!sameHex(expected, input.signature ?? '')) return { ok: false, status: 401, reason: 'bad signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }
  const body = parsed as { tags?: unknown; ts?: unknown } | null;
  if (body?.ts !== ts) return { ok: false, status: 401, reason: 'body ts does not match the signed timestamp' };
  const tags = body.tags;
  if (
    !Array.isArray(tags) ||
    tags.length === 0 ||
    tags.length > MAX_TAGS ||
    !tags.every((tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= MAX_TAG_LENGTH)
  ) {
    return { ok: false, status: 400, reason: 'tags must be a non-empty list of strings' };
  }
  return { ok: true, tags: tags as string[] };
}

/** Reads the headers and raw body from a Fetch API request and runs `verifyPurge`. */
export async function verifyPurgeRequest(
  request: Request,
  options: { secret: string | undefined; now?: Date; windowSeconds?: number }
): Promise<PurgeVerification> {
  return verifyPurge({
    ...options,
    rawBody: await request.text(),
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
  });
}

function assertSitePath(path: string): void {
  // A site-relative path only: no scheme, no protocol-relative `//host`, no backslash tricks.
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error(`preview path must be a site-relative path starting with one "/": ${JSON.stringify(path)}`);
  }
}

export interface PreviewToken {
  exp: number;
  sig: string;
}

/** Signs a preview of `path`: `sig` is HMAC-SHA256 hex over `${path}.${exp}`, `exp` in unix seconds. */
export function signPreview(options: { path: string; secret: string; ttlSeconds?: number; now?: Date }): PreviewToken {
  assertSitePath(options.path);
  const secret = requireSecret(options.secret, 'PREVIEW_SECRET');
  const exp = unixSeconds(options.now) + (options.ttlSeconds ?? PREVIEW_TTL_SECONDS);
  return { exp, sig: hmacHex(secret, `${options.path}.${exp}`) };
}

/** The marketing app's preview URL: `${siteUrl}${route}?path=&exp=&sig=`. */
export function buildPreviewUrl(options: {
  siteUrl: string;
  path: string;
  secret: string;
  /** The site's preview route, default `/preview`. */
  route?: string;
  ttlSeconds?: number;
  now?: Date;
}): string {
  const { exp, sig } = signPreview(options);
  const url = new URL(options.route ?? '/preview', options.siteUrl);
  url.searchParams.set('path', options.path);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sig);
  return url.toString();
}

export type PreviewVerification = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Checks a preview link's `path`, `exp` and `sig` query parameters: secret configured, a site-relative path, not
 * expired, not further ahead than `maxTtlSeconds` (default PREVIEW_TTL_SECONDS), and a matching HMAC.
 */
export function verifyPreview(
  url: URL | string,
  options: { secret: string | undefined; now?: Date; maxTtlSeconds?: number }
): PreviewVerification {
  if (!options.secret) return { ok: false, reason: 'PREVIEW_SECRET is not set' };
  const params = new URL(url, 'http://preview.invalid').searchParams;
  const path = params.get('path') ?? '';
  const exp = params.get('exp') ?? '';
  try {
    assertSitePath(path);
  } catch {
    return { ok: false, reason: 'bad path' };
  }
  if (!/^\d{1,12}$/.test(exp)) return { ok: false, reason: 'missing or malformed exp' };
  const now = unixSeconds(options.now);
  if (Number(exp) <= now) return { ok: false, reason: 'expired' };
  if (Number(exp) - now > (options.maxTtlSeconds ?? PREVIEW_TTL_SECONDS))
    return { ok: false, reason: 'exp too far ahead' };
  if (!sameHex(hmacHex(options.secret, `${path}.${exp}`), params.get('sig') ?? '')) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true, path };
}
