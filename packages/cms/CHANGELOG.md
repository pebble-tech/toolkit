# @pebbletech/cms

## 0.2.0

### Minor Changes

- fdfd17e: `notifySlackOnCreate` takes an async message builder as well as a sync one, so a notice can look something up (such as
  a running count) before it formats. A throw or rejection while building is logged and never fails the create.

## 0.1.0

### Minor Changes

- 513ef25: First release: `createCmsConfig()` (Postgres on schema `cms`, R2 browser uploads capped at 10 MB by default, Lexical,
  locales, `declare: false` types, no start without `PAYLOAD_SECRET` outside development and test), users with admin,
  editor and preview-reader roles and the first-admin guard with `seedFirstAdmin`, the media collection,
  `withRevalidateHooks()` for signed purge, preview and live-preview links, access helpers (including `adminOrEditorOnly` and `submissionAccess` for create-only service keys), the Slack poster with the
  stamp notice preset, and `@pebbletech/cms/site` for the marketing app to verify purges and preview links.
