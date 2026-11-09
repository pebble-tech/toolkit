# @pebbletech/infra

## 0.5.0

### Minor Changes

- 76c7f17: `Database` makes the runtime role itself on staging and prod when `runtime` is not passed: `<database>_runtime`, a
  login role with a generated password, granted what runtimes need, and protected and retained on prod like the rest.
  The pooler on port 6432 accepts a role made with SQL, so a new product mints no PlanetScale role for its runtimes.
  `runtime` still names an existing role instead, so a stack that passes one sees no change. `Database.runtimeRole` names
  the role in use. The web-only example drops `PG_RUNTIME_ROLE` and `PG_RUNTIME_PASSWORD`.

## 0.4.1

### Patch Changes

- 1ae2c69: A staging or prod `DeployRole` can now create its product's first HTTP API. Before, `CreateApi` with tags was denied (403) because its tag write, `POST /tags/<api arn>`, had no grant, so only an admin session could create one. The role is also confined to its own product. Every call under `/apis/*` (routes, integrations, stages) needs the API's `product` and `env` tags to be the role's own. Creating an API, stage or custom domain needs the request's tags to be its own. Tags can be written only while creating a resource. Certificates are requested only for the product and env's hostnames, and only the product's own certificates can be tagged. All of this was checked against pbt-stg with a real `ApiFunction` deploy, refresh and destroy as the role. Re-apply each product's `infra/bootstrap` stack to update its roles; existing APIs, stages and domains already carry the tags.

## 0.4.0

### Minor Changes

- d84634c: `pebble_operators` gets a home no product owns, and the README writes down who holds which Postgres credential.
  
  - `Operators` takes `cluster` (a `pebble-` cluster name) instead of `stage`, for the toolkit's new cluster operators program (`cluster-operators/`, one stack per cluster, applied by hand with a cluster admin no product uses). With `cluster` the group is protected and kept, as on prod, and `adoptExisting` imports a group that already exists. `stage` and `cluster` together, neither, or `adoptExisting` with `stage` are refused. A 0.3.x call with `stage` (`shared` or `prod`) is unchanged.
  - README "Credentials and ownership": one admin per product per cluster, a separate preview admin used only by previews, the cluster admin for the operators program, never an admin shared across products, and what "a role belongs to the admin that created it" means when an admin is replaced, with the `pscale` commands to mint a product's admins. "Operators" and "A second product on a cluster" describe the cluster program; a product program constructs no `Operators`.
  - The handover from a product's stacks to the cluster program keeps every member's access at every step and is in `cluster-operators/README.md`. Until a cluster's handover, the product whose stacks created its group keeps its 0.3.x `Operators`.
- 7ce7ec5: A product's failures that its error tracker cannot see now reach someone, with no new code.
  
  - `ApiFunction` creates one CloudWatch alarm, `<product>-<env>-<kind>-errors`, on the function's Lambda `Errors`: a crash before the handler runs, a timeout, an out-of-memory kill, a runtime failure. Defaults: one error in 300 seconds sets it off, and a function with no traffic stays `OK`. `alarm: { topicArn, threshold, period }` sets it; `alarm: false` creates none. Without `topicArn` the alarm notifies the account bootstrap's topic on staging and prod (`pebble-<stg|prd>-alarms` in the account and region it deploys to) and no one on previews. On prod it is protected and retained like every other child: once applied there, `alarm: false` or a rollback to 0.3.x fails until the alarm is unprotected and removed from the state by hand, and the alarm itself is deleted in AWS (README, "Remove an applied prod alarm").
  - `Worker` turns Workers observability on; `headSamplingRate` (0 to 1, default 1) sets how many requests it records.
  - `DeployRole` (staging and prod) may create, read, tag and delete CloudWatch alarms named `<product>-<env>-*`, and read every alarm's configuration in the account.
  - The account bootstrap (`bootstrap/`) creates one SNS topic per account, `pebble-<stg|prd>-alarms` (`alarmTopicName`), emailing the address in its `alarmEmail` config, and exports `alarmTopicArn`.
  - New exports: `ApiFunctionAlarm`, `alarmTopicName`. Nothing was removed or renamed; a 0.3.x caller that passes nothing new gets the alarm, notifying the account's topic on staging and prod.
  
  A product's `infra/bootstrap` builds its deploy role from the package version it has installed, so the role bootstraps must be applied from 0.4 before the first release that applies the runtime stacks with 0.4. In this order (README, "Upgrade to 0.4"):
  
  1. On the upgrade branch, change `@pebbletech/infra` to 0.4, install, and rebuild `infra/`. Do not merge yet.
  2. From that build, with SSO, apply the product's `infra/bootstrap` `staging` and `prod` stacks: each deploy role gains the CloudWatch statement. Re-applying them while 0.3.x is still installed changes nothing.
  3. Apply the account bootstrap's `stg` and `prd` stacks with `alarmEmail` set (`bootstrap/README.md`, "Add the alarm topic to an applied stack"), and click the link in AWS's confirmation email: until then the subscription is pending and nothing is delivered. The alarm notifies this topic on staging and prod by default, so this step comes before the release; a product stores and passes nothing for it.
  4. Only then merge and release. Releasing before step 2 fails the first `up` on `cloudwatch:PutMetricAlarm`. Expect one new resource per `ApiFunction` in the release's preview, `aws:cloudwatch/metricAlarm:MetricAlarm <name>-errors`, plus an update to each `Worker`'s script for observability.
- e95c056: `pebble-infra`, the stack steps a product's workflows run around `pulumi up`, ships as a `bin` of the package. Run it from the product's own `node_modules` (`pnpm --dir infra exec pebble-infra <command>`): `prepare`, `configure`, `up`, `preview`, `outputs`, `remove` and `pg-database drop|check`. The README's "Run the stack steps" has the commands.
  
  - Every product fact comes from the product: the id from `Pulumi.yaml`'s `name` (or `--product`), the config entries from its own compiled module (`--entries`), the values from `PEBBLE_INFRA_VALUES` (a JSON object such as `toJSON(secrets)`) or the environment. `aws:region` is an ordinary entry with no default.
  - Lock clearing is explicit: only `--clear-lock` runs `pulumi cancel`; `prepare --preview-only` and `preview` never clear, create, remove or reset a stack.
  - A product's previews reach Postgres only when its entries module exports `previewDatabase = true`; `prepare` and `remove` on a `pr-<n>` stack take `--entries` for it (`prepare --preview-only` does not, since it never reaches Postgres), and the recovery commands a refusal prints include it. A product without a preview database needs no `PG_ADMIN_URL`.
  - The preview reset refuses a stack that holds anything beyond its Stage and database (a `Worker`, a Vercel project), naming the types. `remove` does the same when `pulumi destroy` fails, keeping the state instead of force-removing it.
  - Only Pulumi's missing-stack error counts as a stack that does not exist: any other `pulumi stack select` failure (a backend that cannot be read) stops `prepare` and `remove` before they drop, create or remove anything. `remove` sweeps only the state objects of this Pulumi project (`Pulumi.yaml`'s `name`), so another project's stack of the same name under the same backend path keeps its state.
  - `up` retries only the template1 collision two previews hit when they create databases at once; any other failure stops at once.
  - Secret outputs are masked with `::add-mask::`, escaped as `@actions/core` escapes command data, before they are written to `$GITHUB_OUTPUT`.
  - New exports: `Entry`, `EntriesModule`, `ConfigValues`, `ConfigWrite`, `configWrites` and `stackKind`. Nothing was removed or renamed.
  - The package now depends on `pg`, which only the CLI's database script loads; the component entry does not.
- 4742a50: Two composite actions in the toolkit repo, pinned by commit SHA next to this version. `setup` installs pnpm and Node.js from the product's `packageManager` and `.nvmrc`, runs `pnpm install --frozen-lockfile`, and installs the Pulumi CLI at the version of the product's installed `@pulumi/pulumi`, with its plugin cache and `GITHUB_TOKEN` for plugin downloads (`pulumi: false` skips the CLI). `pulumi` is an optional `uses:` step for `pebble-infra up|preview|remove`; it refuses an installed `@pebbletech/infra` of another major.minor, and hands on what `pebble-infra` writes as one JSON output, `json`. `checkWorkflows` reads a `pulumi` action step as the `pebble-infra` command its literal inputs make (`entries` required), and refuses any other input, value or toolkit path. In the migrate rule, `up` may not carry an `if:`, and an output counts as read only inside `${{ }}`, outside a quoted string. The README's "Workflow actions" has both.
- 653e900: `@pebbletech/infra/testing` gains `checkWorkflows`, which checks a product's own workflow files and returns every violation by job and rule; `loadWorkflow` parses one file. The product gives its data: workflow paths, product id, region, entries module, a secrets table per GitHub environment, the deploy-role secret's name, which stacks own a database, what its `derive` reads, and any stacks the helper cannot read. It reads only literal values from a narrow, documented subset of workflow text and fails on anything outside it; the README's "Check the workflows" has the subset and the rules.
  
  - Each job on a stack runs in the environment its deploy role trusts, assumes exactly the named role secret, and logs in to that stack's state and key.
  - Every secret a job reads, anywhere in the job or through the entries a `PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}` step needs, is in its environment's table, and the table lists nothing no job reads. Naming `secrets` other than as `secrets.NAME` (or the whole `toJSON(secrets)`) fails.
  - Locks: on a long-lived stack whose lock a job clears, every job holds one literal, never-cancelled group; every job on one `pr-<n>` stack, `remove` included, shares one group, which may cancel; matrix copies and jobs of one run need a job-level group, `needs` or `max-parallel: 1`; `preview` and `prepare --preview-only` never clear a lock. A shared long-lived group sets `queue: max`.
  - A deploy migrates before `up`, from an unconditional `pebble-infra outputs --if-exists` in the same job, under exactly the documented guard, with a step after `up` under the opposite guard for the first deploy.
  - The package now depends on `yaml`, which only the testing entry loads. `runProgram`, `defaultMocks` and the other testing exports are unchanged.

### Patch Changes

- 12e4732: On a `pr-<n>` stack, a preview workflow runs `pebble-infra prepare <stack> --entries <module> --clear-lock` before it reads the database URL with `outputs --if-exists`. `prepare` resets a preview stack an interrupted run left and drops its database, so a URL read before it named the database about to be dropped, and its non-empty value kept the first-deploy migration from running on the new one. The README's migrate-first passages and the basefresh preview workflow now prepare first, and `checkWorkflows`'s `migrate` rule fails a job that reads a `pr-<n>` stack's URL before an unconditional `prepare` of that stack in the same job. Long-lived stacks are unchanged: their `prepare` stops on pending operations instead of resetting.
- 8d6d85b: `checkWorkflows` is marked experimental, and the README lists its two known gaps: a literal matrix `include` with two entries on one stack, and a secret read after a quoted `}}` in the same expression.

## 0.4.0-next.0

### Minor Changes

- d84634c: `pebble_operators` gets a home no product owns, and the README writes down who holds which Postgres credential.
  
  - `Operators` takes `cluster` (a `pebble-` cluster name) instead of `stage`, for the toolkit's new cluster operators program (`cluster-operators/`, one stack per cluster, applied by hand with a cluster admin no product uses). With `cluster` the group is protected and kept, as on prod, and `adoptExisting` imports a group that already exists. `stage` and `cluster` together, neither, or `adoptExisting` with `stage` are refused. A 0.3.x call with `stage` (`shared` or `prod`) is unchanged.
  - README "Credentials and ownership": one admin per product per cluster, a separate preview admin used only by previews, the cluster admin for the operators program, never an admin shared across products, and what "a role belongs to the admin that created it" means when an admin is replaced, with the `pscale` commands to mint a product's admins. "Operators" and "A second product on a cluster" describe the cluster program; a product program constructs no `Operators`.
  - The handover from a product's stacks to the cluster program keeps every member's access at every step and is in `cluster-operators/README.md`. Until a cluster's handover, the product whose stacks created its group keeps its 0.3.x `Operators`.
- 7ce7ec5: A product's failures that its error tracker cannot see now reach someone, with no new code.
  
  - `ApiFunction` creates one CloudWatch alarm, `<product>-<env>-<kind>-errors`, on the function's Lambda `Errors`: a crash before the handler runs, a timeout, an out-of-memory kill, a runtime failure. Defaults: one error in 300 seconds sets it off, and a function with no traffic stays `OK`. `alarm: { topicArn, threshold, period }` sets it; `alarm: false` creates none. Without `topicArn` the alarm notifies the account bootstrap's topic on staging and prod (`pebble-<stg|prd>-alarms` in the account and region it deploys to) and no one on previews. On prod it is protected and retained like every other child: once applied there, `alarm: false` or a rollback to 0.3.x fails until the alarm is unprotected and removed from the state by hand, and the alarm itself is deleted in AWS (README, "Remove an applied prod alarm").
  - `Worker` turns Workers observability on; `headSamplingRate` (0 to 1, default 1) sets how many requests it records.
  - `DeployRole` (staging and prod) may create, read, tag and delete CloudWatch alarms named `<product>-<env>-*`, and read every alarm's configuration in the account.
  - The account bootstrap (`bootstrap/`) creates one SNS topic per account, `pebble-<stg|prd>-alarms` (`alarmTopicName`), emailing the address in its `alarmEmail` config, and exports `alarmTopicArn`.
  - New exports: `ApiFunctionAlarm`, `alarmTopicName`. Nothing was removed or renamed; a 0.3.x caller that passes nothing new gets the alarm, notifying the account's topic on staging and prod.
  
  A product's `infra/bootstrap` builds its deploy role from the package version it has installed, so the role bootstraps must be applied from 0.4 before the first release that applies the runtime stacks with 0.4. In this order (README, "Upgrade to 0.4"):
  
  1. On the upgrade branch, change `@pebbletech/infra` to 0.4, install, and rebuild `infra/`. Do not merge yet.
  2. From that build, with SSO, apply the product's `infra/bootstrap` `staging` and `prod` stacks: each deploy role gains the CloudWatch statement. Re-applying them while 0.3.x is still installed changes nothing.
  3. Apply the account bootstrap's `stg` and `prd` stacks with `alarmEmail` set (`bootstrap/README.md`, "Add the alarm topic to an applied stack"), and click the link in AWS's confirmation email: until then the subscription is pending and nothing is delivered. The alarm notifies this topic on staging and prod by default, so this step comes before the release; a product stores and passes nothing for it.
  4. Only then merge and release. Releasing before step 2 fails the first `up` on `cloudwatch:PutMetricAlarm`. Expect one new resource per `ApiFunction` in the release's preview, `aws:cloudwatch/metricAlarm:MetricAlarm <name>-errors`, plus an update to each `Worker`'s script for observability.
- e95c056: `pebble-infra`, the stack steps a product's workflows run around `pulumi up`, ships as a `bin` of the package. Run it from the product's own `node_modules` (`pnpm --dir infra exec pebble-infra <command>`): `prepare`, `configure`, `up`, `preview`, `outputs`, `remove` and `pg-database drop|check`. The README's "Run the stack steps" has the commands.
  
  - Every product fact comes from the product: the id from `Pulumi.yaml`'s `name` (or `--product`), the config entries from its own compiled module (`--entries`), the values from `PEBBLE_INFRA_VALUES` (a JSON object such as `toJSON(secrets)`) or the environment. `aws:region` is an ordinary entry with no default.
  - Lock clearing is explicit: only `--clear-lock` runs `pulumi cancel`; `prepare --preview-only` and `preview` never clear, create, remove or reset a stack.
  - A product's previews reach Postgres only when its entries module exports `previewDatabase = true`; `prepare` and `remove` on a `pr-<n>` stack take `--entries` for it (`prepare --preview-only` does not, since it never reaches Postgres), and the recovery commands a refusal prints include it. A product without a preview database needs no `PG_ADMIN_URL`.
  - The preview reset refuses a stack that holds anything beyond its Stage and database (a `Worker`, a Vercel project), naming the types. `remove` does the same when `pulumi destroy` fails, keeping the state instead of force-removing it.
  - Only Pulumi's missing-stack error counts as a stack that does not exist: any other `pulumi stack select` failure (a backend that cannot be read) stops `prepare` and `remove` before they drop, create or remove anything. `remove` sweeps only the state objects of this Pulumi project (`Pulumi.yaml`'s `name`), so another project's stack of the same name under the same backend path keeps its state.
  - `up` retries only the template1 collision two previews hit when they create databases at once; any other failure stops at once.
  - Secret outputs are masked with `::add-mask::`, escaped as `@actions/core` escapes command data, before they are written to `$GITHUB_OUTPUT`.
  - New exports: `Entry`, `EntriesModule`, `ConfigValues`, `ConfigWrite`, `configWrites` and `stackKind`. Nothing was removed or renamed.
  - The package now depends on `pg`, which only the CLI's database script loads; the component entry does not.
- 4742a50: Two composite actions in the toolkit repo, pinned by commit SHA next to this version. `setup` installs pnpm and Node.js from the product's `packageManager` and `.nvmrc`, runs `pnpm install --frozen-lockfile`, and installs the Pulumi CLI at the version of the product's installed `@pulumi/pulumi`, with its plugin cache and `GITHUB_TOKEN` for plugin downloads (`pulumi: false` skips the CLI). `pulumi` is an optional `uses:` step for `pebble-infra up|preview|remove`; it refuses an installed `@pebbletech/infra` of another major.minor, and hands on what `pebble-infra` writes as one JSON output, `json`. `checkWorkflows` reads a `pulumi` action step as the `pebble-infra` command its literal inputs make (`entries` required), and refuses any other input, value or toolkit path. In the migrate rule, `up` may not carry an `if:`, and an output counts as read only inside `${{ }}`, outside a quoted string. The README's "Workflow actions" has both.
- 653e900: `@pebbletech/infra/testing` gains `checkWorkflows`, which checks a product's own workflow files and returns every violation by job and rule; `loadWorkflow` parses one file. The product gives its data: workflow paths, product id, region, entries module, a secrets table per GitHub environment, the deploy-role secret's name, which stacks own a database, what its `derive` reads, and any stacks the helper cannot read. It reads only literal values from a narrow, documented subset of workflow text and fails on anything outside it; the README's "Check the workflows" has the subset and the rules.
  
  - Each job on a stack runs in the environment its deploy role trusts, assumes exactly the named role secret, and logs in to that stack's state and key.
  - Every secret a job reads, anywhere in the job or through the entries a `PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}` step needs, is in its environment's table, and the table lists nothing no job reads. Naming `secrets` other than as `secrets.NAME` (or the whole `toJSON(secrets)`) fails.
  - Locks: on a long-lived stack whose lock a job clears, every job holds one literal, never-cancelled group; every job on one `pr-<n>` stack, `remove` included, shares one group, which may cancel; matrix copies and jobs of one run need a job-level group, `needs` or `max-parallel: 1`; `preview` and `prepare --preview-only` never clear a lock. A shared long-lived group sets `queue: max`.
  - A deploy migrates before `up`, from an unconditional `pebble-infra outputs --if-exists` in the same job, under exactly the documented guard, with a step after `up` under the opposite guard for the first deploy.
  - The package now depends on `yaml`, which only the testing entry loads. `runProgram`, `defaultMocks` and the other testing exports are unchanged.

### Patch Changes

- 12e4732: On a `pr-<n>` stack, a preview workflow runs `pebble-infra prepare <stack> --entries <module> --clear-lock` before it reads the database URL with `outputs --if-exists`. `prepare` resets a preview stack an interrupted run left and drops its database, so a URL read before it named the database about to be dropped, and its non-empty value kept the first-deploy migration from running on the new one. The README's migrate-first passages and the basefresh preview workflow now prepare first, and `checkWorkflows`'s `migrate` rule fails a job that reads a `pr-<n>` stack's URL before an unconditional `prepare` of that stack in the same job. Long-lived stacks are unchanged: their `prepare` stops on pending operations instead of resetting.
- 8d6d85b: `checkWorkflows` is marked experimental, and the README lists its two known gaps: a literal matrix `include` with two entries on one stack, and a secret read after a quoted `}}` in the same expression.

## 0.3.2

### Patch Changes

- d5a3f9e: Five follow-ups from the staging cutover:
  
  - `Worker` replaces its custom domain delete-first (`deleteBeforeReplace`). A hostname has one Workers custom domain, so a replacement, such as a renamed script, failed on the duplicate under the default create-first. The hostname is unserved for the few seconds between the delete and the create.
  - `VercelProject` replaces its project domain delete-first (`deleteBeforeReplace`). A hostname is on one Vercel project and the provider adds a domain rather than moving it, so a new `projectId` with the same hostname failed under create-first. The hostname is unserved for the few seconds between the delete and the create.
  - Both custom domains stay protected on prod but are no longer retained: with `retainOnDelete`, a delete-first replacement only dropped the old domain from state, so it kept the hostname and the replacement still failed.
  - `Operators` refuses a member name with a dot. A PlanetScale login username (`<role>.<branch>`) was accepted and the grant failed at apply with `role "<role>.<branch>" does not exist`; the error now names the suffix to drop and the role to list. The README says which name to copy.
  - The README states that exactly one product owns `pebble_operators` on each cluster (base-app on `pebble-stg` and `pebble-prd-shared`) and that a second product on that cluster constructs no `Operators`; its `Database` grants to the existing group. A per-cluster program that no product owns is planned for 1.0.
  - The provider enum tests assert each value on its own and count the assertions, so deleting one line can no longer leave a misspelled value passing. `runProgram` (`@pebbletech/infra/testing`) now records `deleteBeforeReplace` on each registration.

## 0.3.1

### Patch Changes

- e090fbd: `VercelProject` sends `vercelAuthentication.deploymentType` as the Vercel provider validates it: `only_preview_deployments` by default (it sent `onlyPreviewDeployments`, which the provider refuses, so `pulumi preview` of a `shared` stack failed). `PreviewProtection` is now `'only_preview_deployments' | 'standard_protection_new' | 'all_deployments'`. Every other enum-valued input the components set was checked against the real providers and is unchanged; a test now pins each one to the spelling its provider accepts.

## 0.3.0

### Minor Changes

- abed6b1: `Database` owns every database through a login role it creates, on every stage. On PlanetScale Postgres only `pscale_admin` can grant membership in a PlanetScale-made role, so the admin could not make such a role the owner and the first `pulumi up` on a fresh cluster failed at `CREATE DATABASE … OWNER`.
  
  | Role | Made by | `pr-<n>` | `staging`, `prod` |
  |---|---|---|---|
  | owner: `<database>` on a preview, `<database>_owner` on staging and prod | the component, with a generated password; no CREATEDB, CREATEROLE or SUPERUSER | owns the database; `directUrl` | owns the database; `directUrl` (port 5432) for migrations and the seed |
  | runtime: `runtime.role` | PlanetScale (`pscale`), passed in with its password | none: the owner is also the runtime | CONNECT; USAGE on `public`; SELECT, INSERT, UPDATE, DELETE on all tables; USAGE, SELECT, UPDATE on all sequences; the same on tables and sequences the owner creates later; owns nothing; `pooledUrl` (pooler, port 6432) |
  | admin: the `adminUrl` user | you, with CREATEDB and CREATEROLE | member of the owner | member of the owner |
  | operators: `pebble_operators` (`OPERATORS_GROUP`), NOLOGIN | `Operators`, from one stack per cluster | member of the owner | member of the owner |
  
  Breaking for callers: the argument `owner: { role, password }` is renamed `runtime` and the type `DatabaseOwner` is now `DatabaseRuntime`. `owner`, `ownerRole` and `ownerPassword` are refused with a message naming the rename, however they are passed (own, inherited or non-enumerable); `runtime` is refused on a preview. On an existing staging or prod stack the next `pulumi up` creates `<database>_owner` and changes the database's owner to it, which needs the admin to be able to act as the current owner.
  
  New: every database's owner role is granted to the cluster's `pebble_operators` group, whose members can connect to, change and drop every toolkit-managed database on that cluster. The new `Operators` component creates the group and keeps its membership as code (`members` from stack config, one grant per name, so removing a name revokes it); one `Operators` per cluster applies it, in `shared` for the staging cluster and in `prod` for the production cluster, before any `Database` there, and a second `Operators` in one program is refused. Both memberships in the owner set `ignoreChanges: ['withAdminOption']`, so a consumer's transformation for the postgresql 3.18.2 refresh bug can go. `@pebbletech/infra/testing`'s `Registration` gains `ignoreChanges` and `dependencies`.
  
  No in-place upgrade of a staging or prod stack created by 0.2.x: the admin-member grant is replaced before the owner changes, so `ALTER DATABASE … OWNER` fails. Recreate the stack (and its database) on 0.3.0, or move the data by dump and restore. No such stack exists for pebble-tech at this release.

## 0.2.0

### Minor Changes

- 4fe4291: `DeployRole` is scoped to its own environment. The `preview` role carries only its state-path and KMS statements (previews are a database and a SQL role, nothing in AWS). `staging` and `prod` roles create, update and delete HTTP APIs only when the API name matches `<product>-<env>-*`, and reach custom domains and their API mappings only under the hostnames `Stage` derives for that product and env; the `/tags/*` grant is gone, so API Gateway tag updates after creation are denied while creation-time tags still arrive through `CreateApi`.
  
  Breaking for callers: `DeployRole` now requires `apex` (the zone name the product's hostnames sit under); a product id must be one DNS label (`^[a-z][a-z0-9]{1,}$`, no hyphen), and a kind passed to `Stage.name` or `Stage.hostname` must be one label too.
  
  The README and `examples/basefresh` no longer use a `StackReference` to reach the `shared` stack (its state lives in another backend prefix, and prod's in another account); `staging` and `prod` look the Vercel project and custom environment up by name. The remaining permission limits are listed in `packages/infra/README.md`.

## 0.1.0

### Minor Changes

- 3af03c0: First release: Pulumi components `Stage`, `VercelProject`, `Database`, `ApiFunction`, `Worker` and `DeployRole`, with namespace, boundary, domain and prod-retention guardrails, and `@pebbletech/infra/testing` for running a program under mocks.
