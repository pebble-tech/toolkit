import { describe, expect, test } from 'vitest';

import { configWrites, type EntriesModule, type Entry } from './index.js';

// A product's entries module: `aws:region` is an ordinary entry, and the runtime role is derived
// from the runtime URL's username.
const RUNTIME = ['staging', 'prod'] as const;
const ALL = ['shared', 'preview', 'staging', 'prod'] as const;
const entries: Entry[] = [
  { key: 'aws:region', env: 'AWS_REGION', secret: false, required: true, stacks: ALL },
  { key: 'vercelTeamId', env: 'VERCEL_TEAM_ID', secret: false, required: true, stacks: ['shared', ...RUNTIME] },
  { key: 'pgAdminUrl', env: 'PG_ADMIN_URL', secret: true, required: true, stacks: ALL },
  { key: 'pgRuntimeUrl', env: 'DATABASE_RUNTIME_URL', secret: true, required: true, stacks: RUNTIME },
  { key: 'pgRuntimeRole', env: 'PG_RUNTIME_ROLE', secret: false, required: true, stacks: RUNTIME },
  { key: 'authSecret', env: 'BETTER_AUTH_SECRET', secret: true, required: true, stacks: RUNTIME },
  { key: 'googleClientId', env: 'GOOGLE_CLIENT_ID', secret: true, required: false, stacks: RUNTIME },
  { key: 'appBaseUrl', env: 'APP_BASE_URL', secret: false, required: false, stacks: RUNTIME },
  { key: 'sentryRelease', env: 'SENTRY_RELEASE', secret: false, required: false, stacks: RUNTIME },
];
const module: EntriesModule = {
  entries,
  derive: (values) => {
    if (!values.DATABASE_RUNTIME_URL) return {};
    const user = decodeURIComponent(new URL(values.DATABASE_RUNTIME_URL).username);
    return { PG_RUNTIME_ROLE: user.includes('.') ? user.slice(0, user.lastIndexOf('.')) : user };
  },
};

const STAGING_ENV = {
  AWS_REGION: 'xx-test-1',
  VERCEL_TEAM_ID: 'team_acme',
  PG_ADMIN_URL: 'postgresql://pscale_admin.abc123:admin@db.example.test:5432/postgres',
  DATABASE_RUNTIME_URL: 'postgresql://acme_app.abc123:owner@db.example.test:6432/acme_stg',
  BETTER_AUTH_SECRET: 'auth',
  SENTRY_RELEASE: 'abc123',
  // Set but blank, as a GitHub secret that exists with no value is.
  APP_BASE_URL: '',
};

describe('configWrites', () => {
  test('staging: required values, the derived runtime role, secrets marked, blank optionals removed', () => {
    const { set, remove } = configWrites(module, 'staging', STAGING_ENV, 'acme');
    expect([set.map((w) => `${w.key}${w.secret ? ' (secret)' : ''}=${w.value}`), remove]).toEqual([
      [
        'aws:region=xx-test-1',
        'acme:vercelTeamId=team_acme',
        `acme:pgAdminUrl (secret)=${STAGING_ENV.PG_ADMIN_URL}`,
        `acme:pgRuntimeUrl (secret)=${STAGING_ENV.DATABASE_RUNTIME_URL}`,
        'acme:pgRuntimeRole=acme_app',
        'acme:authSecret (secret)=auth',
        'acme:sentryRelease=abc123',
      ],
      ['acme:googleClientId', 'acme:appBaseUrl'],
    ]);
  });

  test('a preview stack reads only what its entries list for previews', () => {
    expect(configWrites(module, 'pr-7', STAGING_ENV, 'acme')).toEqual({
      set: [
        { key: 'aws:region', value: 'xx-test-1', secret: false },
        { key: 'acme:pgAdminUrl', value: STAGING_ENV.PG_ADMIN_URL, secret: true },
      ],
      remove: [],
    });
  });

  test('every missing required variable is named at once, aws:region among them', () => {
    expect(() =>
      configWrites(module, 'prod', { VERCEL_TEAM_ID: 'team_acme', BETTER_AUTH_SECRET: ' ' }, 'acme')
    ).toThrow('stack prod needs AWS_REGION, PG_ADMIN_URL, DATABASE_RUNTIME_URL, PG_RUNTIME_ROLE, BETTER_AUTH_SECRET');
  });

  test("a module's namespace replaces the product id for keys that name none", () => {
    const { set } = configWrites({ ...module, namespace: 'shop' }, 'pr-7', STAGING_ENV, 'acme');
    expect(set.map((w) => w.key)).toEqual(['aws:region', 'shop:pgAdminUrl']);
  });

  test('a stack name no stage parses is refused', () => {
    expect(() => configWrites(module, 'pr-07', STAGING_ENV, 'acme')).toThrow('stack "pr-07" is not one of');
  });
});
