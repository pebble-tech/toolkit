---
"@pebbletech/infra": minor
---

`@pebbletech/infra/testing` gains `checkWorkflows`, which checks a product's own workflow files and returns every violation by job and rule; `loadWorkflow` parses one file. The product gives its data: workflow paths, product id, region, entries module, a secrets table per GitHub environment, and which stacks own a database. The README's "Check the workflows" has the rules.

- Each job on a stack runs in the environment its deploy role trusts, assumes a role from a secret, and logs in to that stack's state and key.
- Every secret a job reads, through `secrets.X` or through the entries a `PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}` step needs, is in its environment's table, and the table lists nothing no job reads.
- Locks: a job passing `--clear-lock` on a long-lived stack shares one never-cancelled group with every other job on that stack; every job on a `pr-<n>` stack, `remove` included, shares one group, which may cancel; `preview` and `prepare --preview-only` never clear a lock. A shared long-lived group sets `queue: max`.
- A deploy migrates before `up`, from `pebble-infra outputs --if-exists`, with a guarded step after `up` for the first deploy.
- The package now depends on `yaml`, which only the testing entry loads. `runProgram`, `defaultMocks` and the other testing exports are unchanged.
