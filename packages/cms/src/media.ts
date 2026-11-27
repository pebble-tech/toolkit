import type { CollectionConfig } from 'payload';

import { anyone, isStaff } from './access.js';

export const MEDIA_SLUG = 'media';

/** Raster images only: an SVG can carry script, and media is served as-is from the media domain. */
export const MEDIA_MIME_TYPES = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'];

/** Public images with required alt text; staff upload, edit and delete them. */
export function createMediaCollection(): CollectionConfig {
  return {
    slug: MEDIA_SLUG,
    access: { read: anyone, create: isStaff, update: isStaff, delete: isStaff },
    upload: { mimeTypes: MEDIA_MIME_TYPES },
    fields: [{ name: 'alt', type: 'text', required: true }],
  };
}
