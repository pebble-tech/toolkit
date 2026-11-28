# @pebbletech/config

## 0.2.1

### Patch Changes

- 49153ed: The README documents Renovate auto-merge as an opt-in preset, `packages/config/renovate-automerge.json` in the toolkit
  repo, which a repo adds as a second `extends` entry. The shared Renovate preset no longer auto-merges anything. Renovate
  reads both from GitHub, so the package's files are unchanged apart from the README.

## 0.2.0

### Minor Changes

- dc49704: Add `@pebbletech/config/oxlint-site.json` for site repos: the oxlint preset plus ignores for generated files and build
  output, with imports of `next`, `payload`, `@payloadcms/*` and any path under them allowed only in `apps/cms`. Add `@pebbletech/config/vite`
  with `devServerPort`, `sentryOptions` and `nitroSkewProtection`, option builders taken from base-app's
  `vite.config.ts`. `oxlint.json`, `oxfmt.json` and `tsconfig.base.json` are unchanged by this release apart from the
  base-app sync in its other changeset.
- b0a4f9b: Sync the presets with base-app again. The oxlint preset's `vitest/expect-expect` now sets `assertFunctionNames` to
  `expect`, `expectUnauthenticated` and `expectForbiddenRole`, as base-app does. That list replaces oxlint's default
  one, so a test whose only assertion is `assert.*`, `expectTypeOf` or `assertType` is now reported as having no
  assertion. The `lintStaged` map runs `oxfmt --no-error-on-unmatched-pattern`. Nothing else in `oxlint.json`,
  `oxfmt.json` or `tsconfig.base.json` changes.

### Patch Changes

- 0abf263: The README documents the shared Renovate preset, `packages/config/renovate.json` in the toolkit repo, which a repo
  extends from GitHub with `"extends": ["github>pebble-tech/toolkit//packages/config/renovate"]`. Renovate reads the
  preset from GitHub, so the package's files are unchanged apart from the README.

## 0.1.0

### Minor Changes

- d6e0e17: First release: base-app's tsconfig base, oxlint and oxfmt presets, and the `lintStaged` map.
