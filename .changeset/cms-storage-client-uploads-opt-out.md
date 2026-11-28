---
'@pebbletech/cms': minor
---

`storageCollections` entries may now be `{ slug, clientUploads: false }`. That collection still stores in R2 but is
uploaded through the CMS only: the signing endpoint refuses it with 403 for every user, including a create-only API
key, and the admin uploads through the server so the collection's own checks run. A plain slug behaves as before.
An opted-out collection is stored in its own folder, `<slug>/`, so a new upload's key and URL include it and a server-side
upload cannot overwrite a media object. Media and plain-slug collections keep their keys and URLs. Adding the option adds
a `prefix` column to that collection, which needs a migration. `media` is refused as an opted-out entry.
