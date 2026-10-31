// Every stack config value the program reads, listed once: `pebble-infra configure|up|preview --entries
// dist/entries.js` writes it, and the workflows test checks every value is set in the environment that deploys it.
import type { Entry } from '@pebbletech/infra';

const RUNTIME = ['staging', 'prod'] as const;
const VERCEL = ['shared', ...RUNTIME] as const;

export const entries: Entry[] = [
  { key: 'apex', env: 'APEX', secret: false, required: true, stacks: RUNTIME },
  { key: 'cloudflareZoneId', env: 'CLOUDFLARE_ZONE_ID', secret: false, required: true, stacks: RUNTIME },
  { key: 'pgAdminUrl', env: 'PG_ADMIN_URL', secret: true, required: true, stacks: ['preview', ...RUNTIME] },
  { key: 'pgRuntimeRole', env: 'PG_RUNTIME_ROLE', secret: false, required: true, stacks: RUNTIME },
  { key: 'pgRuntimePassword', env: 'PG_RUNTIME_PASSWORD', secret: true, required: true, stacks: RUNTIME },
  { key: 'cloudflare:apiToken', env: 'CLOUDFLARE_API_TOKEN', secret: true, required: true, stacks: RUNTIME },
  { key: 'vercel:apiToken', env: 'VERCEL_API_TOKEN', secret: true, required: true, stacks: VERCEL },
  { key: 'vercel:team', env: 'VERCEL_TEAM_ID', secret: false, required: true, stacks: VERCEL },
];

/** `pr-<n>` stacks create a `Database`. */
export const previewDatabase = true;
