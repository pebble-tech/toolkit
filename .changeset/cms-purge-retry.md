---
'@pebbletech/cms': minor
---

A failed cache purge is retried. The revalidate hooks try each batch up to 3 times (`attempts`) with exponential
backoff and jitter, only for a network error, a timeout, a 5xx or a 429; any other 4xx fails at once. Each try is signed
afresh and a batch already accepted is not resent. A purge that gives up is logged at error level with its tags,
attempts and status, and passed to the new optional `onGiveUp`. `sendPurge` still tries once unless `attempts` is set,
and now throws a `PurgeError`. The README also says to opt every collection a less-trusted caller can create in out of
`storageCollections` with `clientUploads: false`.
