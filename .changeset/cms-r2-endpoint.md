---
'@pebbletech/cms': minor
---

`createCmsConfig` takes an R2 endpoint: `storage.endpoint`, or `R2_ENDPOINT` when storage is read from the environment. The
option wins over the variable, and both replace the default `https://<accountId>.r2.cloudflarestorage.com`; with neither
set, nothing changes. The value must be a bare `https://host[:port]` origin and is refused with credentials, a path,
a query or a fragment. `http://` is accepted only when `NODE_ENV` is `development` or `test`, for a local fake R2 such
as MinIO. `accountId` stays required.
