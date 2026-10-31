---
"@pebbletech/infra": minor
---

Two composite actions in the toolkit repo, pinned by commit SHA next to this version. `setup` installs pnpm and Node.js from the product's `packageManager` and `.nvmrc`, runs `pnpm install --frozen-lockfile`, and installs the Pulumi CLI at the version of the product's installed `@pulumi/pulumi`, with its plugin cache and `GITHUB_TOKEN` for plugin downloads (`pulumi: false` skips the CLI). `pulumi` is an optional `uses:` step for `pebble-infra up|preview|remove`; it refuses an installed `@pebbletech/infra` of another major.minor, and hands on what `pebble-infra` writes as one JSON output, `json`. `checkWorkflows` reads a `pulumi` action step as the `pebble-infra` command its literal inputs make (`entries` required), and refuses any other input, value or toolkit path. In the migrate rule, `up` may not carry an `if:`, and an output counts as read only inside `${{ }}`, outside a quoted string. The README's "Workflow actions" has both.
