---
'@pebbletech/config': minor
---

Add `@pebbletech/config/oxlint-site.json` for site repos: the oxlint preset plus ignores for generated files and build
output, with `next`, `payload` and `@payloadcms/*` imports allowed only in `apps/cms`. Add `@pebbletech/config/vite`
with `devServerPort`, `sentryOptions` and `nitroSkewProtection`, option builders taken from base-app's
`vite.config.ts`. `oxlint.json`, `oxfmt.json` and `tsconfig.base.json` are unchanged by this release apart from the
base-app sync in its other changeset.
