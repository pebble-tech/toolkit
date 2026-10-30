---
"@pebbletech/infra": minor
---

`@pebbletech/infra/testing` gains `checkWorkflows`, which checks a product's own workflow files and returns every violation by job and rule; `loadWorkflow` parses one file. The product gives its data: workflow paths, product id, region, entries module, a secrets table per GitHub environment, the deploy-role secret's name, which stacks own a database, what its `derive` reads, and any stacks the helper cannot read. It reads a narrow, documented subset of workflow text and fails on anything outside it; the README's "Check the workflows" has the subset and the rules.

- Each job on a stack runs in the environment its deploy role trusts, assumes exactly the named role secret, and logs in to that stack's state and key.
- Every secret a job reads, anywhere in the job or through the entries a `PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}` step needs, is in its environment's table, and the table lists nothing no job reads. A secret read by a computed name fails.
- Locks: on a long-lived stack whose lock a job clears, every job holds one literal, never-cancelled group; every job on one `pr-<n>` stack, `remove` included, shares one group, which may cancel; matrix copies and jobs of one run need a job-level group, `needs` or `max-parallel: 1`; `preview` and `prepare --preview-only` never clear a lock. A shared long-lived group sets `queue: max`.
- A deploy migrates before `up`, from an unconditional `pebble-infra outputs --if-exists`, under exactly the documented guard, with a step after `up` under the opposite guard for the first deploy.
- The package now depends on `yaml`, which only the testing entry loads. `runProgram`, `defaultMocks` and the other testing exports are unchanged.
