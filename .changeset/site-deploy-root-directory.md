---
'@pebbletech/infra': patch
---

`site-deploy.yml` takes an optional `working-directory` input, the Vercel project's root directory (for example
`apps/marketing`), and passes it to `prepare`, which makes it an empty directory beside `.vercel/output` in the fresh
deploy directory. `vercel deploy --prebuilt` fails with "The provided path .../apps/marketing does not exist" for a
project with a root directory unless that directory exists; the CLI only checks it and uploads nothing from it. The
value is main's input, never the artifact's, and must be a plain relative path (no `..`, no empty segment, at most 64
bytes, not inside `.vercel`). Left empty, nothing changes. The copyable stub passes `working-directory: apps/marketing`.
