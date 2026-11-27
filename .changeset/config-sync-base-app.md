---
'@pebbletech/config': minor
---

Sync the presets with base-app again. The oxlint preset's `vitest/expect-expect` now also counts
`expectUnauthenticated` and `expectForbiddenRole` as assertions, and the `lintStaged` map runs
`oxfmt --no-error-on-unmatched-pattern`. Nothing else in `oxlint.json`, `oxfmt.json` or `tsconfig.base.json` changes.
