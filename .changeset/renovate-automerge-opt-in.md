---
'@pebbletech/config': patch
---

The README documents Renovate auto-merge as an opt-in preset, `packages/config/renovate-automerge.json` in the toolkit
repo, which a repo adds as a second `extends` entry. The shared Renovate preset no longer auto-merges anything. Renovate
reads both from GitHub, so the package's files are unchanged apart from the README.
