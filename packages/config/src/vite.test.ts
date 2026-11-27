import { describe, expect, test } from 'vitest';

import { devServerPort, nitroSkewProtection, sentryOptions } from './vite.js';

describe('devServerPort', () => {
  test('takes PORT', () => {
    expect(devServerPort({ PORT: '4123' })).toBe(4123);
  });

  test.each([{}, { PORT: '' }, { PORT: '0' }, { PORT: 'abc' }])('falls back to 3000 for %o', (env) => {
    expect(devServerPort(env)).toBe(3000);
  });
});

describe('sentryOptions', () => {
  test('is undefined without SENTRY_AUTH_TOKEN, so a local build sends nothing', () => {
    expect(sentryOptions({ project: 'site-web' }, { SENTRY_ORG: 'acme', SENTRY_RELEASE: 'abc123' })).toBeUndefined();
  });

  test('builds the plugin options from the environment when the token is set', () => {
    expect(
      sentryOptions(
        { project: 'site-web' },
        { SENTRY_AUTH_TOKEN: 'token', SENTRY_ORG: 'acme', SENTRY_RELEASE: 'abc123' }
      )
    ).toEqual({
      org: 'acme',
      project: 'site-web',
      authToken: 'token',
      release: { name: 'abc123' },
      telemetry: false,
    });
  });

  test("falls back to Pebble's org and no release", () => {
    expect(sentryOptions({ project: 'site-web' }, { SENTRY_AUTH_TOKEN: 'token' })).toEqual({
      org: 'pebble-tech-sdn-bhd',
      project: 'site-web',
      authToken: 'token',
      release: undefined,
      telemetry: false,
    });
  });

  test('takes another fallback org, which SENTRY_ORG still overrides', () => {
    expect(sentryOptions({ project: 'p', org: 'other' }, { SENTRY_AUTH_TOKEN: 't' })?.org).toBe('other');
    expect(sentryOptions({ project: 'p', org: 'other' }, { SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'acme' })?.org).toBe(
      'acme'
    );
  });
});

describe('nitroSkewProtection', () => {
  test('pins the deploy to its id', () => {
    expect(nitroSkewProtection('gh-123-1-stg')).toEqual({
      manifest: { deploymentId: 'gh-123-1-stg' },
      vercel: { skewProtection: true, config: { version: 3, deploymentId: 'gh-123-1-stg' } },
    });
  });

  test.each([undefined, ''])('turns skew protection off without an id (%o)', (id) => {
    expect(nitroSkewProtection(id)).toEqual({
      manifest: { deploymentId: undefined },
      vercel: { skewProtection: false, config: { version: 3, deploymentId: undefined } },
    });
  });
});
