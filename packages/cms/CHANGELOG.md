# @pebbletech/cms

## 0.5.0

### Minor Changes

- 85f2422: `createCmsConfig` takes an R2 endpoint: `storage.endpoint`, or `R2_ENDPOINT` when storage is read from the environment. The
  option wins over the variable, and both replace the default `https://<accountId>.r2.cloudflarestorage.com`; with neither
  set, nothing changes. The value must be a bare `https://host[:port]` origin and is refused with credentials, a path,
  a query or a fragment. `http://` is accepted only when `NODE_ENV` is `development` or `test`, for a local fake R2 such
  as MinIO. `accountId` stays required.

## 0.4.0

### Minor Changes

- 3a5937b: A failed cache purge is retried. The revalidate hooks try each batch up to 3 times (`attempts`) with exponential
  backoff and jitter, only for a network error, a timeout, a 5xx or a 429; any other 4xx fails at once. Each try is signed
  afresh and a batch already accepted is not resent. A purge that gives up is logged at error level with its tags,
  attempts and status, and passed to the new optional `onGiveUp`. `sendPurge` still tries once unless `attempts` is set,
  and now throws a `PurgeError`. The README also says to opt every collection a less-trusted caller can create in out of
  `storageCollections` with `clientUploads: false`.

## 0.3.0

### Minor Changes

- 4b53863: `storageCollections` entries may now be `{ slug, clientUploads: false }`. That collection still stores in R2 but is
  uploaded through the CMS only: the signing endpoint refuses it with 403 for every user, including a create-only API
  key, and the admin uploads through the server so the collection's own checks run. A plain slug behaves as before.
  An opted-out collection is stored in its own folder, `<slug>/`, so a new upload's key and URL include it and a server-side
  upload cannot overwrite a media object. Media and plain-slug collections keep their keys and URLs. Adding the option adds
  a `prefix` column to that collection, which needs a migration. `media` is refused as an opted-out entry.

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
