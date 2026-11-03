---
"@pebbletech/infra": minor
---

`pebble_operators` gets a home no product owns, and the README writes down who holds which Postgres credential.

- `Operators` takes `cluster` (a `pebble-` cluster name) instead of `stage`, for the toolkit's new cluster operators program (`cluster-operators/`, one stack per cluster, applied by hand with a cluster admin no product uses). With `cluster` the group is protected and kept, as on prod, and `adoptExisting` imports a group that already exists. `stage` and `cluster` together, neither, or `adoptExisting` with `stage` are refused. A 0.3.x call with `stage` (`shared` or `prod`) is unchanged.
- README "Credentials and ownership": one admin per product per cluster, a separate preview admin used only by previews, the cluster admin for the operators program, never an admin shared across products, and what "a role belongs to the admin that created it" means when an admin is replaced, with the `pscale` commands to mint a product's admins. "Operators" and "A second product on a cluster" describe the cluster program; a product program constructs no `Operators`.
- The handover from a product's stacks to the cluster program keeps every member's access at every step and is in `cluster-operators/README.md`. Until a cluster's handover, the product whose stacks created its group keeps its 0.3.x `Operators`.
