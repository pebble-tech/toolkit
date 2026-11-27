---
'@pebbletech/cms': minor
---

First release: `createCmsConfig()` (Postgres on schema `cms`, R2 browser uploads capped at 10 MB by default, Lexical,
locales, `declare: false` types, no start without `PAYLOAD_SECRET` outside development and test), users with admin,
editor and preview-reader roles and the first-admin guard with `seedFirstAdmin`, the media collection,
`withRevalidateHooks()` for signed purge, preview and live-preview links, access helpers (including `adminOrEditorOnly` and `submissionAccess` for create-only service keys), the Slack poster with the
stamp notice preset, and `@pebbletech/cms/site` for the marketing app to verify purges and preview links.
