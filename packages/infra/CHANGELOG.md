# @pebbletech/infra

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
