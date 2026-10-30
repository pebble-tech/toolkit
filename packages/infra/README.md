# @pebbletech/infra

Pulumi components for a Pebble product's `infra/` program. A product gets previews, staging and production by
pinning a version; the guardrails are defaults it cannot turn off.

| Component | Creates | Refuses |
|---|---|---|
| `Stage` | nothing; parses the stack name and names, tags and protects everything else | a product id that is not one DNS label, starts with `pebble`, or is `pr`/`staging`/`prod`/`shared`; a kind that is not one DNS label; any stack other than `pr-<n>`, `staging`, `prod`, `shared` |
| `VercelProject` | `shared`: the project (no Git connection, private source, Vercel Authentication on previews), custom environments, the protection bypass. `staging`/`prod`: env vars (secrets `sensitive`), the domain bound to the stage's environment (replaced delete-first, because a hostname is on one project: a new `projectId` leaves the hostname unserved for a few seconds during the apply; protected but not retained on prod, so that delete frees the hostname), an unproxied Cloudflare CNAME | previews; the project outside `shared`; env vars or domains on `shared`; a secret-looking name in `vars` |
| `Database` | an explicit Postgres provider on port 5432 with `sslmode=verify-full`, the owner login role, the database owned by it, the owner's grant to `pebble_operators`, the `public` revoke, and on staging/prod the runtime role's grants; `directUrl` (owner) and `pooledUrl` (runtime) as secrets. See [Database](#database) | any `owner*` argument; staging/prod without `runtime`; `runtime` on a preview; a runtime role that is the owner or the operators group; a database or owner name longer than 63 characters. The names are always derived from `stage.databaseName()` |
| `ApiFunction` | Lambda `nodejs22.x` from a prebuilt bundle, log group (30 days), role with the permissions boundary and only `AWSLambdaBasicExecutionRole`, HTTP API without the execute-api endpoint, regional ACM certificate validated in Cloudflare, custom domain, CNAME | no domain; a boundary other than the stage's own `<product>-<env>-boundary` in the current account (a typed `PermissionsBoundaryArn` from `Stage` or `DeployRole`, checked when it resolves, so `pulumi preview` fails). Timeouts above 29 s are clamped |
| `Worker` | Workers script from a prebuilt module, R2 bucket `<product>-<env>-<kind>` (on prod, `adoptExisting` imports that same name instead of creating it), plain and secret bindings, custom domain (replaced delete-first, because a hostname has one custom domain: a new script name leaves the hostname unserved for a few seconds during the apply; protected but not retained on prod, so that delete frees the hostname) | a secret-looking name in `vars` unless listed in `plainTextAllowed`; `adoptExisting` outside prod |
| `DeployRole` | the GitHub OIDC role for one product and env, its inline policy, and the boundary policy its roles must carry. `preview` allows the state bucket and the KMS key only. `staging` and `prod` also allow Lambda, API Gateway, ACM, logs and IAM inside `<product>-<env>`. Takes `product`, `env`, the repo and the apex (the zone name): the trusted GitHub environment, the account's OIDC provider, the state bucket and paths (`pebble-<stg\|prd>-pulumi-state/<product>/<env>`, plus `<product>/shared` for staging) and the KMS key (`alias/pebble-<stg\|prd>-pulumi-<env>`) are derived | a product id that is not one DNS label, a `pebble` product, or an apex that is not lowercase labels with no leading or trailing dot |
| `Operators` | the cluster's `pebble_operators` group (kept on destroy) and one membership grant per name in `members`, through the same admin provider as `Database`. See [Operators](#operators) | `pr-<n>` and `staging` (one stack per cluster owns the group: `shared` or `prod`); a second `Operators` in the same program; an empty or repeated member name; a member name with a dot (a PlanetScale login username: list the role before the dot) |

Every component refuses a hostname or name outside its stage (`NamespaceError`), and every refusal is a
`GuardrailError` subclass. On `prod` (and `shared`, which owns production's Vercel project) every child resource gets
`protect` and `retainOnDelete`; the Postgres provider, which is configuration rather than a cloud resource, does not.
The two custom domains (`Worker`'s and `VercelProject`'s) are protected but not retained: they are replaced
delete-first, and a retained domain would only leave state, so it would keep the hostname from its replacement.

## Names

| Stack | `stage.name('api')` | `stage.hostname('api', 'pebbletech.my')` | `stage.databaseName()` |
|---|---|---|---|
| `pr-7` | `base-pr-7-api` | `api-base-pr-7.pebbletech.my` | `base_pr_7` |
| `staging` | `base-staging-api` | `api-base-stg.pebbletech.my` | `base_stg` |
| `prod` | `base-prod-api` | `api-base.pebbletech.my` | `base_prd` |

Hostnames and database names keep base-app's `stg`/`prd` suffixes; resource names use the env.

A product id is one DNS label (`^[a-z][a-z0-9]{1,}$`, no hyphen), and a kind passed to `Stage.name` or `hostname` is one label too.

## Database

The database is always owned by a login role the component creates, so the admin can create, alter and drop it with no
help from PlanetScale: on PlanetScale Postgres only `pscale_admin` can grant membership in a PlanetScale-made role, so
the admin could not act as such a role to make it an owner. The PlanetScale-made role is passed as `runtime`, is
granted what runtimes need, and owns nothing.

| Role | Made by | `pr-<n>` | `staging`, `prod` |
|---|---|---|---|
| owner: `<database>` on a preview, `<database>_owner` on staging and prod | the component, with a generated password; no CREATEDB, CREATEROLE or SUPERUSER | owns the database; `directUrl` | owns the database; `directUrl` (port 5432) for migrations and the seed |
| runtime: `runtime.role` | PlanetScale (`pscale`), passed in with its password | none: the owner is also the runtime | CONNECT; USAGE on `public`; SELECT, INSERT, UPDATE, DELETE on all tables; USAGE, SELECT, UPDATE on all sequences; the same on tables and sequences the owner creates later; owns nothing; `pooledUrl` (pooler, port 6432) |
| admin: the `adminUrl` user | you, with CREATEDB and CREATEROLE | member of the owner | member of the owner |
| operators: `pebble_operators` (`OPERATORS_GROUP`), NOLOGIN | `Operators`, from one stack per cluster | member of the owner | member of the owner |

PUBLIC's CONNECT on the database is revoked on every stage. A role name or password for the owner is never an
argument: `owner` (renamed to `runtime` in 0.3.0), `ownerRole` and `ownerPassword` are refused.

`pebble_operators` is one group per cluster, shared by every product and stack on it; it is a constant, not an
argument. Membership gives connect, change and drop on every toolkit-managed database on that cluster, present and
future. [`Operators`](#operators) creates it and its members.

Both memberships in the owner ignore `withAdminOption`: postgresql 3.18.2 reads a membership without its grantor, and
on PostgreSQL 16+ the admin's implicit ADMIN OPTION row in a role it created would otherwise make `pulumi up --refresh`
replace the grant and revoke it. Consumers need no transformation for this.

```ts
const db = new Database('db', {
  stage,
  adminUrl: config.requireSecret('pgAdminUrl'),
  ...(stage.isPreview
    ? {}
    : { runtime: { role: config.require('pgRuntimeRole'), password: config.requireSecret('pgRuntimePassword') } }),
});
```

## Operators

Membership of `pebble_operators` is code. `Operators` creates the group and grants it to each name in `members`;
removing a name revokes that membership on the next apply. Use one `Operators` per cluster, in the program of the one
product that owns the group there ([below](#a-second-product-on-a-cluster)): in `shared` for the staging cluster and in
`prod` for the production cluster. A program takes one; a second is refused, naming the first, because two lists
would manage the same memberships. Apply it before any other stack on a fresh cluster, and in `prod`
construct it before `Database`: a `Database` on a cluster without the group fails at its `db-operators` grant with
`role "pebble_operators" does not exist`.

```ts
new Operators('operators', {
  stage,
  adminUrl: config.requireSecret('pgAdminUrl'),
  members: config.getObject<string[]>('operators') ?? [],
});
```

`members` are SQL role names. PlanetScale shows a role's login username as `<role>.<branch>` (for example
`pscale_api_44lpekcp7tl0.main`); copy the part before the dot (`pscale_api_44lpekcp7tl0`). A name with a dot is
refused, because the grant would fail at apply with `role "<role>.<branch>" does not exist`. Read them from stack config
(`pulumi config set --path 'operators[0]' <role>`), so the names are not committed in source. The group is kept when
the stack is destroyed, because other stacks' databases are granted to it. The member grants are not protected, even
on `shared` and `prod`, so a removal goes through.

### A second product on a cluster

The group belongs to the cluster, but `Operators` lives in a product's program, so exactly one product's stacks own it
on each cluster. On `pebble-stg` and `pebble-prd-shared` that product is base-app: its `shared` stack owns the group
on `pebble-stg` and its `prod` stack on `pebble-prd-shared`, and its list is the cluster's list. A second product on
either cluster constructs no `Operators` (its `Database` grants its owner to the existing group), and its people are
added to base-app's list. A second `Operators` on the same cluster would fail at apply creating a group that already
exists, and if the group were imported instead, removing a name from one list would revoke a membership the other
list still holds. Moving the group into a per-cluster program that no product owns is planned for 1.0.

Grant by hand only in an emergency: the list does not know about a hand grant, so the next apply neither removes nor
reports it. The fallback when no stack can run is one line, run as the admin:

```sql
GRANT pebble_operators TO "<their role>" WITH ADMIN OPTION;  -- that person can then GRANT and REVOKE it too
```

The admin (`ci-admin`) is needed only for that first grant, because it created the group. On PostgreSQL 16+ a
`REVOKE` removes only a membership the revoking role granted; for one granted by another role it prints a warning and
leaves the membership in place.

## Ownership

- `shared`: the Vercel project and its custom environments, and the staging cluster's `Operators` when this product
  owns the group ([A second product on a cluster](#a-second-product-on-a-cluster)). Apply it before
  `staging`, `prod` and previews. It has no deploy role
  of its own. The staging role applies it, so its state lives at `<product>/shared` in `pebble-stg-pulumi-state` and
  its secrets use the staging key (`stateKeyAlias('shared')` is `alias/pebble-stg-pulumi-staging`).
- `pr-<n>`: a database and its owner role. Previews pass env to `vercel deploy`.
- `staging`, `prod`: database, its owner role and the runtime role's grants (the runtime role itself is
  PlanetScale's), API, Worker, web env vars and domain. `prod` also applies the production cluster's `Operators`,
  under the same rule.
- `infra/bootstrap` (a separate project, applied by hand with SSO): one `DeployRole` per env (`preview`, `staging`,
  `prod`). `ApiFunction` defaults its boundary to `<product>-<env>-boundary` in the current account, the policy the
  deploy role created.

`staging` and `prod` look the shared project up by name. The state of `shared` is a second backend, and prod's state
is in another account. `shared` must already exist. The name is the project that stack created (`<product>-web`,
unless it set another name). `staging` passes `customEnvironmentId` into `VercelProject`. `prod` omits it and targets
`production`.

```ts
import * as vercel from '@pulumiverse/vercel';

const project = vercel.getProjectOutput({ name: `${stage.product}-web` });
const customEnvironmentId = stage.isProd
  ? undefined
  : vercel.getCustomEnvironmentOutput({ projectId: project.id, name: 'staging' }).id;
```

Tearing down `shared` or `prod` takes an explicit step: every child there is protected, so run
`pulumi state unprotect --all -s <stack>` before `pulumi destroy -s <stack>`.

A staging or prod deploy role can create a custom domain of any name (`POST` on `/domainnames` has no name condition), can edit routes, integrations and stages under another HTTP API's id, and can change a hostname in a sub-zone of its apex whose label ends with `-<product>-stg` or `-<product>` (for example `api-x-stg.foo-basefresh-stg.pebbletech.my`); API Gateway tag updates after creation are denied, and creation-time tags still arrive through `CreateApi`.

The `preview` role's policy contains the state-bucket statements and the KMS key statement only.

`DeployRole` gates `iam:PassRole` on `iam:PassedToService` alone (PassRole has no boundary condition key); the boundary
is enforced where roles are written: `CreateRole`, `AttachRolePolicy`, `PutRolePolicy` and
`PutRolePermissionsBoundary` on `role/<product>-<env>-*` require the env's boundary, and `DeleteRolePermissionsBoundary`
is denied.

## Use it

```sh
pnpm add @pebbletech/infra @pulumi/pulumi
```

Use pnpm. `@pulumi/pulumi` declares `typescript <7` as an optional peer; pnpm warns, but npm refuses to install it next
to TypeScript 7, so npm users need an `overrides` entry or `--legacy-peer-deps`.

```ts
import { Database, Stage } from '@pebbletech/infra';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const stage = new Stage('stage', { product: 'basefresh' });
const db = new Database('db', { stage, adminUrl: config.requireSecret('pgAdminUrl') });
export const databaseUrl = db.directUrl;
```

### Precompile the program

Pulumi's TypeScript peer is `<7`, so Pulumi must not compile the program. Compile `infra/` with `tsc` (`module` and
`moduleResolution` `NodeNext`, `"type": "module"` in its `package.json`) and point Pulumi at the JS:

```yaml
# infra/Pulumi.yaml
name: basefresh
runtime:
  name: nodejs
  options:
    typescript: false
main: dist/index.js
```

Run `tsc -p infra` before every `pulumi preview` or `pulumi up`. Bundles (`ApiFunction.code`, `Worker.script`) come
from the product's own build; the components never bundle.

## Run the stack steps

The package ships `pebble-infra`, the steps a workflow runs around `pulumi up`. Run it from the product's own
`node_modules`, in the directory holding `Pulumi.yaml`, after `pulumi login`:

```sh
pnpm --dir infra exec pebble-infra up staging --entries dist/entries.js --clear-lock
```

| Command | Does |
|---|---|
| `prepare <stack> [--clear-lock]` | selects the stack, or creates it with `PULUMI_SECRETS_PROVIDER`; restores its secrets key from the state on a fresh checkout; starts a preview again from nothing when an interrupted run left only its database |
| `prepare <stack> --preview-only` | selects the stack and restores its key; never clears a lock, creates, removes or resets, and refuses a stack that is missing, never updated or has pending operations |
| `configure <stack> --entries <module>` | writes the stack config from the product's entries module; values go to Pulumi through stdin |
| `up <stack> --entries <module> [--clear-lock] [--outputs <name>]` | `prepare`, `configure`, `pulumi up` (previews with `--refresh`, tried again twice on a template1 collision), then the outputs to `$GITHUB_OUTPUT` when it is set |
| `preview <stack> --entries <module> [--summary]` | `prepare --preview-only`, `configure`, `pulumi preview --diff`; `--summary` appends the diff to `$GITHUB_STEP_SUMMARY` |
| `outputs <stack> [--github-output] [--if-exists] [--outputs <name>]` | prints the stack's `outputs` export with secrets hidden, or writes it to `$GITHUB_OUTPUT`; `--if-exists` exits 0 with nothing when the stack or the export does not exist yet (read before `up` to migrate first) |
| `remove pr-<n> [--clear-lock]` | destroys a preview, drops its database and role, removes the stack and deletes every state object it left under the S3 backend path |
| `pg-database <drop\|check> <name> [--owner <role>]` | drops a database and its role with `PG_ADMIN_URL`, or exits 3 naming the admin that could |

- **Product id**: `Pulumi.yaml`'s `name`, or `--product`. The preview database is `<product>_pr_<n>`, the name
  `Database` gives it.
- **Locks**: only `--clear-lock` runs `pulumi cancel`. Pass it only from a job that owns the stack's lock, in a
  concurrency group that is never cancelled; a preview never clears one.
- **Preview reset**: a `pr-<n>` stack with pending operations or no resources is removed and created again only when
  it holds nothing beyond the database closure (`postgresql`, `random`, `Stage`, `Database`). Anything else (a
  `Worker`, a Vercel project) stops `prepare` by type, for `pulumi refresh` or `remove`.
- **Outputs**: each key of the export becomes a step output in snake case (`databaseUrl` → `database_url`). Every
  line of a secret value is masked with `::add-mask::` before anything is written; multi-line values use the heredoc
  form.
- **Environment**: `PULUMI_BACKEND_URL` and `PULUMI_SECRETS_PROVIDER` for `prepare`, `up`, `preview` and `remove`;
  `PG_ADMIN_URL` for preview stacks; `aws` on `PATH` for `remove`.

### The entries module

Every stack config value the program reads, listed once. `configure` imports the compiled module; the program's own
`readInputs` imports the same one:

```ts
// infra/src/entries.ts
import type { ConfigValues, Entry } from '@pebbletech/infra';

const RUNTIME = ['staging', 'prod'] as const;
export const entries: Entry[] = [
  { key: 'aws:region', env: 'AWS_REGION', secret: false, required: true, stacks: ['shared', 'preview', ...RUNTIME] },
  { key: 'pgAdminUrl', env: 'PG_ADMIN_URL', secret: true, required: true, stacks: ['shared', 'preview', ...RUNTIME] },
  { key: 'pgRuntimeUrl', env: 'DATABASE_RUNTIME_URL', secret: true, required: true, stacks: RUNTIME },
  { key: 'pgRuntimeRole', env: 'PG_RUNTIME_ROLE', secret: false, required: true, stacks: RUNTIME },
];

/** Values computed from the others: the runtime role is the URL's username without its `.branch`. */
export function derive(values: ConfigValues): ConfigValues {
  const user = values.DATABASE_RUNTIME_URL && decodeURIComponent(new URL(values.DATABASE_RUNTIME_URL).username);
  return user ? { PG_RUNTIME_ROLE: user.split('.')[0] } : {};
}
```

A key without a namespace goes in the product's (or the module's `namespace` export). `aws:region` has no default:
it is an entry like any other. A missing required value stops `configure` naming every missing variable; a set but
blank optional value removes its key, so a value from an earlier run cannot linger.

Values come from `PEBBLE_INFRA_VALUES` first, when it holds a JSON object (in a workflow,
`PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}`), then from the environment. Invalid JSON or anything but an object of
strings is refused without repeating it, and no child process (Pulumi, `aws`, the database script) gets the variable.
`PG_ADMIN_URL` is read the same way.

## Test a program

`@pebbletech/infra/testing` runs a program against Pulumi's mocks and returns every registered resource with the
options the engine would see (`protect`, `retainOnDelete`, import id, `ignoreChanges`, dependencies, parent). It
rejects with the program's first unhandled rejection, such as a guardrail thrown inside an `apply`, as `pulumi
preview` would fail:

```ts
import { runProgram } from '@pebbletech/infra/testing';

const { resources } = await runProgram({ project: 'basefresh', stack: 'prod' }, () => program());
expect(resources.filter((r) => r.type === 'aws:lambda/function:Function' && !r.protect)).toEqual([]);
```

[`examples/basefresh`](https://github.com/pebble-tech/toolkit/tree/main/examples/basefresh) is a whole product program
with its tests.
