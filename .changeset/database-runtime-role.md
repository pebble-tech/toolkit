---
'@pebbletech/infra': minor
---

`Database` makes the runtime role itself on staging and prod when `runtime` is not passed: `<database>_runtime`, a
login role with a generated password, granted what runtimes need, and protected and retained on prod like the rest.
The pooler on port 6432 accepts a role made with SQL, so a new product mints no PlanetScale role for its runtimes.
`runtime` still names an existing role instead, so a stack that passes one sees no change. `Database.runtimeRole` names
the role in use. The web-only example drops `PG_RUNTIME_ROLE` and `PG_RUNTIME_PASSWORD`.
