import type { GeneratePreviewURL, LivePreviewConfig } from 'payload';

import { buildPreviewUrl } from './site.js';

export interface PreviewLinkOptions {
  /** The site path that shows `doc`, or null when it has none (yet). */
  path: (doc: Record<string, unknown>, locale: string | undefined) => string | null | undefined;
  /** Default: `MARKETING_URL`. */
  siteUrl?: string;
  /** Default: `PREVIEW_SECRET`. */
  secret?: string;
  /** The site's preview route, default `/preview`. */
  route?: string;
  ttlSeconds?: number;
}

function link(options: PreviewLinkOptions, doc: Record<string, unknown>, locale: string | undefined): string | null {
  const siteUrl = options.siteUrl ?? process.env.MARKETING_URL;
  const secret = options.secret ?? process.env.PREVIEW_SECRET;
  const path = options.path(doc, locale);
  if (!siteUrl || !secret || !path) return null;
  return buildPreviewUrl({ siteUrl, secret, path, route: options.route, ttlSeconds: options.ttlSeconds });
}

/** For a collection's `admin.preview`: a signed link to the site's preview route, or no button when unset. */
export function previewLink(options: PreviewLinkOptions): GeneratePreviewURL {
  return (doc, { locale }) => link(options, doc, locale);
}

/** For `admin.livePreview.url`: the same signed link, framed in the admin while the editor types. */
export function livePreviewLink(options: PreviewLinkOptions): NonNullable<LivePreviewConfig['url']> {
  return ({ data, locale }) => link(options, data, locale?.code);
}
