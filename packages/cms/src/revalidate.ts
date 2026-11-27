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
}

/**
 * Posts a signed purge of `tags` to the marketing app (in batches of MAX_TAGS) and throws unless each answers 2xx. The body and signature follow
 * `signPurge`; the bypass header is sent when a bypass secret is known.
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
  for (let start = 0; start < valid.length; start += MAX_TAGS) {
    const { body, headers } = signPurge({ tags: valid.slice(start, start + MAX_TAGS), secret });
    if (bypass) headers[VERCEL_BYPASS_HEADER] = bypass;
    const response = await (target.fetch ?? globalThis.fetch)(new URL(target.route ?? '/api/revalidate', siteUrl), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`purge answered ${response.status}`);
  }
}

type Doc = Record<string, unknown> | undefined;

export interface RevalidateOptions extends PurgeTarget {
  /** Tags to purge for a changed or deleted document. Default: the collection tag and the doc's id and slug tags. */
  tags?: (args: { slug: string; doc: Doc; previousDoc: Doc }) => string[];
}

function isPublished(doc: Doc): boolean {
  return doc?._status === 'published';
}

// A purge that fails must not fail the editor's save: the page stays stale until the next publish, and the error is logged.
async function purge(req: PayloadRequest, tags: string[], options: RevalidateOptions): Promise<void> {
  const configured =
    (options.siteUrl ?? process.env.MARKETING_URL) && (options.secret ?? process.env.REVALIDATE_SECRET);
  if (!configured && ['development', 'test'].includes(process.env.NODE_ENV ?? '')) return;
  try {
    await sendPurge(tags, options);
  } catch (error) {
    req.payload.logger.error({ err: error, tags }, 'cache purge failed');
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
  options: PurgeTarget & { tags?: (args: { slug: string; doc: Doc }) => string[] } = {}
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
