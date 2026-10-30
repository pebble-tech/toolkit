---
"@pebbletech/infra": minor
---

`pebble-infra`, the stack steps a product's workflows run around `pulumi up`, ships as a `bin` of the package. Run it from the product's own `node_modules` (`pnpm --dir infra exec pebble-infra <command>`): `prepare`, `configure`, `up`, `preview`, `outputs`, `remove` and `pg-database drop|check`. The README's "Run the stack steps" has the commands.

- Every product fact comes from the product: the id from `Pulumi.yaml`'s `name` (or `--product`), the config entries from its own compiled module (`--entries`), the values from `PEBBLE_INFRA_VALUES` (a JSON object such as `toJSON(secrets)`) or the environment. `aws:region` is an ordinary entry with no default.
- Lock clearing is explicit: only `--clear-lock` runs `pulumi cancel`; `prepare --preview-only` and `preview` never clear, create, remove or reset a stack.
- The preview reset refuses a stack that holds anything beyond its database (a `Worker`, a Vercel project), naming the types.
- `up` retries only the template1 collision two previews hit when they create databases at once; any other failure stops at once.
- Secret outputs are masked with `::add-mask::` before they are written to `$GITHUB_OUTPUT`.
- New exports: `Entry`, `EntriesModule`, `ConfigValues`, `ConfigWrite`, `configWrites` and `stackKind`. Nothing was removed or renamed.
- The package now depends on `pg`, which only the CLI's database script loads; the component entry does not.
