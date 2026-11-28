import type { CollectionConfig, GlobalConfig, PayloadRequest } from 'payload';

import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  SITE_CACHE_TAG,
  VERCEL_BYPASS_HEADER,
  collectionTag,
  docTag,
  globalTag,
  signPurge,
} from './site.js';

export interface PurgeTarget {
  /** The marketing app's origin. Default: `MARKETING_URL`. */
  siteUrl?: string;
  /** Default: `REVALIDATE_SECRET`. */
  secret?: string;
  /** The marketing project's Vercel protection bypass secret. Default: `VERCEL_PROTECTION_BYPASS_MARKETING`. */
  bypassSecret?: string;
  /** Default `/api/revalidate`. */
  route?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Tries per batch, the first included. `sendPurge` defaults to 1 (no retry); the hooks default to
   * `DEFAULT_PURGE_ATTEMPTS`. Only a network error, a timeout, a 5xx or a 429 is tried again.
   */
  attempts?: number;
  /** Backoff before retry n is a random value between half and all of `min(maxDelayMs, baseDelayMs * 2^(n-1))`. */
  baseDelayMs?: number;
  /** Default 2000. */
  maxDelayMs?: number;
  /** Timeout of each request. Default 10000. */
  timeoutMs?: number;
  /** Test seams: how to wait, and the source of jitter in [0, 1). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Tries per batch the hooks make unless `attempts` says otherwise. */
export const DEFAULT_PURGE_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2000;

/** Thrown by `sendPurge` when a batch gave up. `tags` are the ones not delivered: the failed batch and any after it. */
export class PurgeError extends Error {
  constructor(
    message: string,
    readonly details: { tags: string[]; attempts: number; status?: number; cause?: unknown }
  ) {
    super(message, { cause: details.cause });
    this.name = 'PurgeError';
  }
  get tags(): string[] {
    return this.details.tags;
  }
  get attempts(): number {
    return this.details.attempts;
  }
  /** The last HTTP status, absent when the last attempt got no answer. */
  get status(): number | undefined {
    return this.details.status;
  }
}

// A 429 or a 5xx may clear; any other 4xx (a bad signature, a refused tag, a protected route) will not.
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Posts a signed purge of `tags` to the marketing app (in batches of MAX_TAGS) and throws a `PurgeError` unless each
 * answers 2xx. The body and signature follow `signPurge`; the bypass header is sent when a bypass secret is known.
 *
 * Each batch is tried up to `attempts` times (default 1: one try, as before). A retry is signed afresh, so its
 * timestamp is current for the receiver's window, and a batch that was accepted is never sent again. A purge is
 * idempotent at the receiver, so a retry after a lost answer only purges twice.
 */
export async function sendPurge(tags: string[], target: PurgeTarget = {}): Promise<void> {
  const siteUrl = target.siteUrl ?? process.env.MARKETING_URL;
  const secret = target.secret ?? process.env.REVALIDATE_SECRET;
  const bypass = target.bypassSecret ?? process.env.VERCEL_PROTECTION_BYPASS_MARKETING;
  if (!siteUrl) throw new Error('MARKETING_URL is not set');
  if (!secret) throw new Error('REVALIDATE_SECRET is not set');
  // The receiver refuses a whole purge for one bad tag, so a tag it would refuse (empty, or over MAX_TAG_LENGTH as a
  // long slug makes) is dropped here and the rest still purge. More than MAX_TAGS go as several signed purges.
  const valid = [...new Set(tags)].filter((tag) => tag.length > 0 && tag.length <= MAX_TAG_LENGTH);
  if (valid.length === 0) throw new Error('no purgeable tags');
  const attempts = Math.max(1, Math.floor(target.attempts ?? 1));
  const baseDelay = target.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = target.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = target.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = target.random ?? Math.random;
  for (let start = 0; start < valid.length; start += MAX_TAGS) {
    const batch = valid.slice(start, start + MAX_TAGS);
    for (let attempt = 1; ; attempt++) {
      const { body, headers } = signPurge({ tags: batch, secret });
      if (bypass) headers[VERCEL_BYPASS_HEADER] = bypass;
      let status: number | undefined;
      let failure: unknown;
      try {
        const response = await (target.fetch ?? globalThis.fetch)(new URL(target.route ?? '/api/revalidate', siteUrl), {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(target.timeoutMs ?? 10_000),
        });
        if (response.ok) break;
        status = response.status;
        failure = new Error(`purge answered ${status}`);
      } catch (error) {
        failure = error;
      }
      if ((status !== undefined && !isTransientStatus(status)) || attempt >= attempts) {
        const reason = status !== undefined ? `purge answered ${status}` : `purge request failed: ${String(failure)}`;
        throw new PurgeError(reason, { tags: valid.slice(start), attempts: attempt, status, cause: failure });
      }
      const ceiling = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      await sleep(Math.round(ceiling / 2 + (random() * ceiling) / 2));
    }
  }
}

type Doc = Record<string, unknown> | undefined;

export interface RevalidateOptions extends PurgeTarget {
  /** Tags to purge for a changed or deleted document. Default: the collection tag and the doc's id and slug tags. */
  tags?: (args: { slug: string; doc: Doc; previousDoc: Doc }) => string[];
  /** Called when a purge gave up, after it is logged. A throw or rejection is logged and swallowed. */
  onGiveUp?: (info: PurgeGiveUp) => void | Promise<void>;
}

/** What a purge that gave up reports: the tags not purged, the tries made on the last batch, and the error. */
export interface PurgeGiveUp {
  tags: string[];
  attempts: number;
  error: unknown;
}

function isPublished(doc: Doc): boolean {
  return doc?._status === 'published';
}

// A purge that fails must not fail the editor's save. Payload awaits the hook, so the retries run inline: a background
// retry could be cut off when a serverless host ends the response. Worst case is `attempts` requests of `timeoutMs`
// plus at most `maxDelayMs` between them; the save waits that long only when the site is down. A purge that gives up is
// logged at error level and handed to `onGiveUp`; the page stays stale until the next publish.
async function purge(req: PayloadRequest, tags: string[], options: RevalidateOptions): Promise<void> {
  const configured =
    (options.siteUrl ?? process.env.MARKETING_URL) && (options.secret ?? process.env.REVALIDATE_SECRET);
  if (!configured && ['development', 'test'].includes(process.env.NODE_ENV ?? '')) return;
  try {
    await sendPurge(tags, { ...options, attempts: options.attempts ?? DEFAULT_PURGE_ATTEMPTS });
  } catch (error) {
    const given = error instanceof PurgeError;
    const info: PurgeGiveUp = { tags: given ? error.tags : tags, attempts: given ? error.attempts : 0, error };
    req.payload.logger.error(
      { err: error, tags: info.tags, attempts: info.attempts, status: given ? error.status : undefined },
      'cache purge failed'
    );
    try {
      await options.onGiveUp?.(info);
    } catch (hookError) {
      req.payload.logger.error({ err: hookError, tags: info.tags }, 'cache purge onGiveUp failed');
    }
  }
}

function defaultTags({ slug, doc, previousDoc }: { slug: string; doc: Doc; previousDoc: Doc }): string[] {
  const tags = new Set([collectionTag(slug)]);
  for (const d of [doc, previousDoc]) {
    if (d?.id !== undefined) tags.add(docTag(slug, d.id as string | number));
    if (typeof d?.slug === 'string' && d.slug) tags.add(docTag(slug, d.slug));
  }
  return [...tags];
}

/**
 * Adds afterChange and afterDelete hooks that purge the marketing app's cache. With drafts on, only a change that
 * publishes or unpublishes purges; saving or autosaving a draft does not.
 */
export function withRevalidateHooks(collection: CollectionConfig, options: RevalidateOptions = {}): CollectionConfig {
  const drafts = Boolean(collection.versions && typeof collection.versions === 'object' && collection.versions.drafts);
  const tagsFor = options.tags ?? defaultTags;
  return {
    ...collection,
    hooks: {
      ...collection.hooks,
      afterChange: [
        ...(collection.hooks?.afterChange ?? []),
        async ({ doc, previousDoc, req }) => {
          if (!drafts || isPublished(doc) || isPublished(previousDoc)) {
            await purge(req, tagsFor({ slug: collection.slug, doc, previousDoc }), options);
          }
          return doc;
        },
      ],
      afterDelete: [
        ...(collection.hooks?.afterDelete ?? []),
        async ({ doc, req }) => {
          await purge(req, tagsFor({ slug: collection.slug, doc, previousDoc: undefined }), options);
          return doc;
        },
      ],
    },
  };
}

/** The same for a global; default tags are the global's tag and the site-wide tag. */
export function withGlobalRevalidateHooks(
  global: GlobalConfig,
  options: PurgeTarget & {
    tags?: (args: { slug: string; doc: Doc }) => string[];
    onGiveUp?: RevalidateOptions['onGiveUp'];
  } = {}
): GlobalConfig {
  const drafts = Boolean(global.versions && typeof global.versions === 'object' && global.versions.drafts);
  const tagsFor = options.tags ?? (({ slug }) => [globalTag(slug), SITE_CACHE_TAG]);
  return {
    ...global,
    hooks: {
      ...global.hooks,
      afterChange: [
        ...(global.hooks?.afterChange ?? []),
        async ({ doc, previousDoc, req }) => {
          if (!drafts || isPublished(doc) || isPublished(previousDoc)) {
            await purge(req, tagsFor({ slug: global.slug, doc }), options);
          }
          return doc;
        },
      ],
    },
  };
}
