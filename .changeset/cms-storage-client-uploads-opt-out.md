---
'@pebbletech/cms': minor
---

`storageCollections` entries may now be `{ slug, clientUploads: false }`. That collection still stores in R2 but is
uploaded through the CMS only: the signing endpoint refuses it with 403 for every user, including a create-only API
key, and the admin uploads through the server so the collection's own checks run. A plain slug behaves as before.
