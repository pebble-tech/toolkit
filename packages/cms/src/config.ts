import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { s3Storage } from '@payloadcms/storage-s3';
import { randomBytes } from 'node:crypto';
import { buildConfig } from 'payload';
import type { CollectionConfig, Config, GlobalConfig, Plugin, SanitizedConfig } from 'payload';

import { MEDIA_SLUG, createMediaCollection } from './media.js';
import { USERS_SLUG, createUsersCollection } from './users.js';

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const CMS_SCHEMA = 'cms';
const MIN_SECRET_LENGTH = 32;
// Placeholders published in templates (the base-site skeleton, create-payload-app's .env.example): never a real secret.
const KNOWN_PLACEHOLDERS = new Set(['dev-only-secret-change-in-production', 'YOUR_SECRET_HERE']);

type PoolOptions = Parameters<typeof postgresAdapter>[0]['pool'];

export interface R2StorageOptions {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public origin media is read from, such as `https://media-bfa.pebbletech.my`. URLs are built from it on read. */
  mediaBaseUrl?: string;
}

export interface CmsConfigOptions {
  /** The client's own collections; users and media come first. */
  collections?: CollectionConfig[];
  globals?: GlobalConfig[];
  /** Default `['en']`; the first is the default locale. */
  locales?: string[];
  /** Extra API-key-only roles, see `createUsersCollection`. */
  serviceRoles?: string[];
  /** Upload collections besides media that store files in R2. */
  storageCollections?: string[];
  /** Largest file accepted, in bytes, both in a signed R2 upload URL and in an upload through the CMS. Default 10 MB. */
  maxUploadBytes?: number;
  /** Where `payload generate:types` writes, such as `packages/content/src/payload-types.ts`. */
  typesOutputFile?: string;
  /** `admin.importMap.baseDir`, normally the directory of `payload.config.ts`. */
  importMapBaseDir?: string;
  migrationDir?: string;
  /** Default: `DATABASE_URL`. */
  databaseUrl?: string;
  pool?: Omit<PoolOptions, 'connectionString'>;
  /** Default: from `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `MEDIA_BASE_URL`. */
  storage?: R2StorageOptions;
  /** Default: `lexicalEditor()`. */
  editor?: Config['editor'];
  sharp?: Config['sharp'];
  plugins?: Plugin[];
  /** Merged over the admin settings this package sets (`user`, `importMap`). */
  admin?: Config['admin'];
}

function devOrTest(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

/**
 * `PAYLOAD_SECRET`, refused when unset, a known template placeholder or shorter than 32 characters outside development and test. In development and
 * test an unset secret becomes a random one for this process (sessions end on restart); there is no literal fallback.
 */
function payloadSecret(): string {
  const secret = process.env.PAYLOAD_SECRET;
  if (secret && secret.length >= MIN_SECRET_LENGTH && !KNOWN_PLACEHOLDERS.has(secret)) return secret;
  if (devOrTest() && !secret) return randomBytes(32).toString('hex');
  throw new Error(
    `PAYLOAD_SECRET must be set to a generated value of at least ${MIN_SECRET_LENGTH} characters (NODE_ENV=${process.env.NODE_ENV ?? 'unset'})`
  );
}

function storageFromEnv(): R2StorageOptions | undefined {
  const names = ['R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length === 0) {
    return {
      bucket: process.env.R2_BUCKET!,
      accountId: process.env.R2_ACCOUNT_ID!,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      mediaBaseUrl: process.env.MEDIA_BASE_URL,
    };
  }
  // Uploads to a serverless function's disk are lost, so outside development storage is not optional.
  if (devOrTest()) return undefined;
  throw new Error(`R2 storage needs ${missing.join(', ')} (NODE_ENV=${process.env.NODE_ENV ?? 'unset'})`);
}

function r2Plugin(storage: R2StorageOptions, slugs: string[]): Plugin {
  const base = storage.mediaBaseUrl?.replace(/\/+$/, '');
  const collection = base
    ? {
        disablePayloadAccessControl: true as const,
        generateFileURL: ({ filename, prefix }: { filename: string; prefix?: string }) =>
          [base, prefix, encodeURIComponent(filename)].filter(Boolean).join('/'),
      }
    : true;
  return s3Storage({
    bucket: storage.bucket,
    clientUploads: true,
    collections: Object.fromEntries(slugs.map((slug) => [slug, collection])),
    config: {
      endpoint: `https://${storage.accountId}.r2.cloudflarestorage.com`,
      region: 'auto',
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      // R2 rejects the CRC32 checksums the AWS SDK adds to presigned uploads by default.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    },
  });
}

/**
 * The shared Payload config for a client site's CMS: Postgres on the `cms` schema, R2 media with browser uploads
 * capped at `maxUploadBytes`, the Lexical editor, locales, users and media, and types written with `declare: false`.
 * Export its result as `payload.config.ts`'s default.
 */
export function createCmsConfig(options: CmsConfigOptions = {}): Promise<SanitizedConfig> {
  const secret = payloadSecret();
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error('maxUploadBytes must be a positive whole number of bytes');
  }
  const locales = options.locales ?? ['en'];
  if (locales.length === 0) throw new Error('locales must name at least one locale');
  const storage = options.storage ?? storageFromEnv();
  const cmsUrl = process.env.CMS_URL;

  return buildConfig({
    secret,
    serverURL: cmsUrl,
    ...(cmsUrl ? { csrf: [cmsUrl] } : {}),
    admin: {
      ...options.admin,
      user: USERS_SLUG,
      ...(options.importMapBaseDir ? { importMap: { baseDir: options.importMapBaseDir } } : {}),
    },
    collections: [
      createUsersCollection({ serviceRoles: options.serviceRoles }),
      createMediaCollection(),
      ...(options.collections ?? []),
    ],
    globals: options.globals,
    editor: options.editor ?? lexicalEditor(),
    localization: { locales, defaultLocale: locales[0]!, fallback: true },
    typescript: { declare: false, ...(options.typesOutputFile ? { outputFile: options.typesOutputFile } : {}) },
    upload: { limits: { fileSize: maxUploadBytes } },
    db: postgresAdapter({
      schemaName: CMS_SCHEMA,
      migrationDir: options.migrationDir,
      pool: { ...options.pool, connectionString: options.databaseUrl ?? process.env.DATABASE_URL },
    }),
    sharp: options.sharp,
    plugins: [
      ...(storage ? [r2Plugin(storage, [MEDIA_SLUG, ...(options.storageCollections ?? [])])] : []),
      ...(options.plugins ?? []),
    ],
  });
}
