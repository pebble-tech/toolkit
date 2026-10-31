// basefresh's stack config, listed once: `pebble-infra configure|up|preview --entries dist/entries.js` writes it, and the
// workflows test checks every value is set in the environment that deploys it.
import type { ConfigValues, Entry } from '@pebbletech/infra';

const ALL = ['shared', 'preview', 'staging', 'prod'] as const;
const RUNTIME = ['staging', 'prod'] as const;

export const entries: Entry[] = [
  { key: 'aws:region', env: 'AWS_REGION', secret: false, required: true, stacks: ALL },
  { key: 'apex', env: 'APEX', secret: false, required: true, stacks: ALL },
  { key: 'cloudflareZoneId', env: 'CLOUDFLARE_ZONE_ID', secret: false, required: true, stacks: ALL },
  { key: 'cloudflareAccountId', env: 'CLOUDFLARE_ACCOUNT_ID', secret: false, required: true, stacks: ALL },
  { key: 'pgAdminUrl', env: 'PG_ADMIN_URL', secret: true, required: true, stacks: ALL },
  { key: 'pgRuntimeRole', env: 'PG_RUNTIME_ROLE', secret: false, required: true, stacks: RUNTIME },
  { key: 'pgRuntimePassword', env: 'PG_RUNTIME_PASSWORD', secret: true, required: true, stacks: RUNTIME },
  { key: 'operators', env: 'PG_OPERATORS', secret: false, required: false, stacks: ['shared', 'prod'] },
  { key: 'authSecret', env: 'BETTER_AUTH_SECRET', secret: true, required: true, stacks: RUNTIME },
  // The account bootstrap's `alarmTopicArn`; a GitHub environment secret, since the ARN holds the account id.
  { key: 'alarmTopicArn', env: 'ALARM_TOPIC_ARN', secret: false, required: true, stacks: RUNTIME },
  { key: 'cloudflare:apiToken', env: 'CLOUDFLARE_API_TOKEN', secret: true, required: true, stacks: RUNTIME },
  { key: 'vercel:apiToken', env: 'VERCEL_API_TOKEN', secret: true, required: true, stacks: ['shared', ...RUNTIME] },
  { key: 'vercel:team', env: 'VERCEL_TEAM_ID', secret: false, required: true, stacks: ['shared', ...RUNTIME] },
];

/** The runtime role and its password, from the pooled URL PlanetScale gives that role (`<role>.<branch>:<password>@…`). */
export function derive(values: ConfigValues): ConfigValues {
  if (!values.DATABASE_RUNTIME_URL) return {};
  const url = new URL(values.DATABASE_RUNTIME_URL);
  return {
    PG_RUNTIME_ROLE: decodeURIComponent(url.username).split('.')[0],
    PG_RUNTIME_PASSWORD: decodeURIComponent(url.password),
  };
}

/** `pr-<n>` stacks create a `Database`. */
export const previewDatabase = true;
