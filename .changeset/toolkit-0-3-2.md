---
"@pebbletech/infra": patch
---

Four follow-ups from the staging cutover:

- `Worker` replaces its custom domain delete-first (`deleteBeforeReplace`). A hostname has one Workers custom domain, so a replacement, such as a renamed script, failed on the duplicate under the default create-first. The hostname is unserved for the few seconds between the delete and the create.
- `Operators` refuses a member name with a dot. A PlanetScale login username (`<role>.<branch>`) was accepted and the grant failed at apply with `role "<role>.<branch>" does not exist`; the error now names the suffix to drop and the role to list. The README says which name to copy.
- The README states that exactly one product owns `pebble_operators` on each cluster (base-app on `pebble-stg` and `pebble-prd-shared`) and that a second product on that cluster constructs no `Operators`; its `Database` grants to the existing group. A per-cluster program that no product owns is planned for 1.0.
- The provider enum tests assert each value on its own and count the assertions, so deleting one line can no longer leave a misspelled value passing. `runProgram` (`@pebbletech/infra/testing`) now records `deleteBeforeReplace` on each registration.
