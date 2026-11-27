---
'@pebbletech/config': patch
---

The README documents the shared Renovate preset, `packages/config/renovate.json` in the toolkit repo, which a repo
extends from GitHub with `"extends": ["github>pebble-tech/toolkit//packages/config/renovate"]`. Renovate reads the
preset from GitHub, so the package's files are unchanged apart from the README.
