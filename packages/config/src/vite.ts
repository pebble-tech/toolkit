// Option builders for a product's vite.config.ts, taken from base-app's apps/web/vite.config.ts. They return plain
// objects for the product to hand to its own plugins, so this package depends on none of vite, nitro, TanStack or
// Sentry.

type Env = Record<string, string | undefined>;

/** The dev server port: `PORT` when it is a number other than 0, else 3000. */
export function devServerPort(env: Env = process.env): number {
  return Number(env.PORT) || 3000;
}

export type SentryOptions = {
  org: string;
  project: string;
  authToken: string;
  release: { name: string } | undefined;
  telemetry: false;
};

/**
 * Options for the Sentry Vite plugin (`sentryTanstackStart` and the like), or `undefined` when `SENTRY_AUTH_TOKEN` is
 * unset: source maps and the release go to Sentry only where CI holds the token. `SENTRY_ORG` names the org, `org` is
 * the fallback; `SENTRY_RELEASE` names the release.
 */
export function sentryOptions(
  { project, org = 'pebble-tech-sdn-bhd' }: { project: string; org?: string },
  env: Env = process.env
): SentryOptions | undefined {
  if (!env.SENTRY_AUTH_TOKEN) return undefined;
  return {
    org: env.SENTRY_ORG ?? org,
    project,
    authToken: env.SENTRY_AUTH_TOKEN,
    release: env.SENTRY_RELEASE ? { name: env.SENTRY_RELEASE } : undefined,
    telemetry: false,
  };
}

export type NitroSkewProtectionOptions = {
  manifest: { deploymentId: string | undefined };
  vercel: { skewProtection: boolean; config: { version: 3; deploymentId: string | undefined } };
};

/**
 * Nitro options for Vercel Skew Protection from the product's own per-deploy id (base-app's `BASE_DEPLOYMENT_ID`).
 * With an id, the manifest id and `skewProtection` make Nitro's Vercel preset add the `__vdpl` cookie route, and
 * `vercel.config` writes `deploymentId` to `.vercel/output/config.json`. Without one, `skewProtection` is `false`, not
 * unset, so Vercel's own `VERCEL_DEPLOYMENT_ID` and `VERCEL_SKEW_PROTECTION_ENABLED` cannot add the route. An empty
 * id counts as none.
 */
export function nitroSkewProtection(deploymentId: string | undefined): NitroSkewProtectionOptions {
  const id = deploymentId || undefined;
  return {
    manifest: { deploymentId: id },
    vercel: { skewProtection: Boolean(id), config: { version: 3, deploymentId: id } },
  };
}
