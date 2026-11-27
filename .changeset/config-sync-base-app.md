---
'@pebbletech/config': minor
---

Sync the presets with base-app again. The oxlint preset's `vitest/expect-expect` now sets `assertFunctionNames` to
`expect`, `expectUnauthenticated` and `expectForbiddenRole`, as base-app does. That list replaces oxlint's default
one, so a test whose only assertion is `assert.*`, `expectTypeOf` or `assertType` is now reported as having no
assertion. The `lintStaged` map runs `oxfmt --no-error-on-unmatched-pattern`. Nothing else in `oxlint.json`,
`oxfmt.json` or `tsconfig.base.json` changes.
