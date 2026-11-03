---
'@pebbletech/infra': patch
---

On a `pr-<n>` stack, a preview workflow runs `pebble-infra prepare <stack> --entries <module> --clear-lock` before it reads the database URL with `outputs --if-exists`. `prepare` resets a preview stack an interrupted run left and drops its database, so a URL read before it named the database about to be dropped, and its non-empty value kept the first-deploy migration from running on the new one. The README's migrate-first passages and the basefresh preview workflow now prepare first, and `checkWorkflows`'s `migrate` rule fails a job that reads a `pr-<n>` stack's URL before an unconditional `prepare` of that stack in the same job. Long-lived stacks are unchanged: their `prepare` stops on pending operations instead of resetting.
