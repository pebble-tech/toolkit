---
"@pebbletech/infra": minor
---

`DeployRole` is scoped to its own environment. The `preview` role carries only its state-path and KMS statements (previews are a database and a SQL role, nothing in AWS). `staging` and `prod` roles create, update and delete HTTP APIs only when the API name matches `<product>-<env>-*`, and reach custom domains and their API mappings only under the hostnames `Stage` derives for that product and env; the `/tags/*` grant is gone, so API Gateway tag updates after creation are denied while creation-time tags still arrive through `CreateApi`.

Breaking for callers: `DeployRole` now requires `apex` (the zone name the product's hostnames sit under); a product id must be one DNS label (`^[a-z][a-z0-9]{1,}$`, no hyphen), and a kind passed to `Stage.name` or `Stage.hostname` must be one label too.

The README and `examples/basefresh` no longer use a `StackReference` to reach the `shared` stack (its state lives in another backend prefix, and prod's in another account); `staging` and `prod` look the Vercel project and custom environment up by name. The remaining permission limits are listed in `packages/infra/README.md`.
