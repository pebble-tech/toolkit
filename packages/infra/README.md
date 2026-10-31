# @pebbletech/infra

Pulumi components for a Pebble product's `infra/` program. A product gets previews, staging and production by
pinning a version; the guardrails are defaults it cannot turn off.

| Component | Creates | Refuses |
|---|---|---|
| `Stage` | nothing; parses the stack name and names, tags and protects everything else | a product id that is not one DNS label, starts with `pebble`, or is `pr`/`staging`/`prod`/`shared`; a kind that is not one DNS label; any stack other than `pr-<n>`, `staging`, `prod`, `shared` |
| `VercelProject` | `shared`: the project (no Git connection, private source, Vercel Authentication on previews), custom environments, the protection bypass. `staging`/`prod`: env vars (secrets `sensitive`), the domain bound to the stage's environment (replaced delete-first, because a hostname is on one project: a new `projectId` leaves the hostname unserved for a few seconds during the apply; protected but not retained on prod, so that delete frees the hostname), an unproxied Cloudflare CNAME | previews; the project outside `shared`; env vars or domains on `shared`; a secret-looking name in `vars` |
| `Database` | an explicit Postgres provider on port 5432 with `sslmode=verify-full`, the owner login role, the database owned by it, the owner's grant to `pebble_operators`, the `public` revoke, and on staging/prod the runtime role's grants; `directUrl` (owner) and `pooledUrl` (runtime) as secrets. See [Database](#database) | any `owner*` argument; staging/prod without `runtime`; `runtime` on a preview; a runtime role that is the owner or the operators group; a database or owner name longer than 63 characters. The names are always derived from `stage.databaseName()` |
| `ApiFunction` | Lambda `nodejs22.x` from a prebuilt bundle, log group (30 days), role with the permissions boundary and only `AWSLambdaBasicExecutionRole`, a CloudWatch alarm on the function's errors (see [Errors alarm](#errors-alarm); `alarm: false` opts out), HTTP API without the execute-api endpoint, regional ACM certificate validated in Cloudflare, custom domain, CNAME | no domain; a boundary other than the stage's own `<product>-<env>-boundary` in the current account (a typed `PermissionsBoundaryArn` from `Stage` or `DeployRole`, checked when it resolves, so `pulumi preview` fails). Timeouts above 29 s are clamped |
| `Worker` | Workers script from a prebuilt module with Workers observability on (`headSamplingRate`, 0 to 1, default 1: every request), R2 bucket `<product>-<env>-<kind>` (on prod, `adoptExisting` imports that same name instead of creating it), plain and secret bindings, custom domain (replaced delete-first, because a hostname has one custom domain: a new script name leaves the hostname unserved for a few seconds during the apply; protected but not retained on prod, so that delete frees the hostname) | a secret-looking name in `vars` unless listed in `plainTextAllowed`; `adoptExisting` outside prod |
| `DeployRole` | the GitHub OIDC role for one product and env, its inline policy, and the boundary policy its roles must carry. `preview` allows the state bucket and the KMS key only. `staging` and `prod` also allow Lambda, API Gateway, ACM, logs, CloudWatch alarms and IAM inside `<product>-<env>`. Takes `product`, `env`, the repo and the apex (the zone name): the trusted GitHub environment, the account's OIDC provider, the state bucket and paths (`pebble-<stg\|prd>-pulumi-state/<product>/<env>`, plus `<product>/shared` for staging) and the KMS key (`alias/pebble-<stg\|prd>-pulumi-<env>`) are derived | a product id that is not one DNS label, a `pebble` product, or an apex that is not lowercase labels with no leading or trailing dot |
| `Operators` | the cluster's `pebble_operators` group (kept on destroy) and one membership grant per name in `members`, through the same admin provider as `Database`. Used by the cluster's operators program (`cluster`, which can adopt the existing group); a product's `shared` or `prod` stack (`stage`) is the 0.3.x form. See [Operators](#operators) | both or neither of `stage` and `cluster`; a cluster name that is not `pebble-` and kebab words; with `stage`, `pr-<n>` and `staging`, and `adoptExisting`; a second `Operators` in the same program; an empty or repeated member name; a member name with a dot (a PlanetScale login username: list the role before the dot) |

Every component refuses a hostname or name outside its stage (`NamespaceError`), and every refusal is a
`GuardrailError` subclass. On `prod` (and `shared`, which owns production's Vercel project) every child resource gets
`protect` and `retainOnDelete`; the Postgres provider, which is configuration rather than a cloud resource, does not.
The two custom domains (`Worker`'s and `VercelProject`'s) are protected but not retained: they are replaced
delete-first, and a retained domain would only leave state, so it would keep the hostname from its replacement.

Every AWS resource that takes tags carries `Stage.tags`: `product`, `env` and `managed-by`. Cost per product is read
from `product` and `env`. Do not add a tag key: the deploy role cannot update an HTTP API's tags after creation, so a
new key would fail the next release on every existing API.

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
| admin: the `adminUrl` user | Kong, with CREATEDB and CREATEROLE: the product's preview admin on `pr-<n>`, its admin on staging and prod ([Credentials and ownership](#credentials-and-ownership)) | member of the owner | member of the owner |
| operators: `pebble_operators` (`OPERATORS_GROUP`), NOLOGIN | the cluster's operators program, which no product owns | member of the owner | member of the owner |

PUBLIC's CONNECT on the database is revoked on every stage. A role name or password for the owner is never an
argument: `owner` (renamed to `runtime` in 0.3.0), `ownerRole` and `ownerPassword` are refused.

`pebble_operators` is one group per cluster, shared by every product and stack on it; it is a constant, not an
argument. Membership gives connect, change and drop on every toolkit-managed database on that cluster, present and
future. The cluster's operators program creates it and its members ([Operators](#operators)); a `Database` only
grants its own owner role to it, which needs no right on the group itself.

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

Membership of `pebble_operators` is code, in one place per cluster: the cluster's operators program,
[`cluster-operators/`](../../cluster-operators/README.md) in this repository, one stack per cluster (`pebble-stg`,
`pebble-prd-shared`), applied by hand with the cluster admin. No product owns it. A product program constructs no
`Operators`: its `Database` grants its owner role to the group with the product's own admin, and its people are added
to the cluster stack's list. On a fresh cluster, apply the cluster stack before any product stack: a `Database` on a
cluster without the group fails at its `db-operators` grant with `role "pebble_operators" does not exist`.

```ts
// cluster-operators/src/cluster-operators.ts
new Operators('operators', { cluster: 'pebble-stg', adminUrl, members, adoptExisting });
```

`members` are SQL role names. PlanetScale shows a role's login username as `<role>.<branch>` (for example
`pscale_api_xxxxxxxxxxxx.main`); copy the part before the dot. A name with a dot is refused, because the grant would
fail at apply with `role "<role>.<branch>" does not exist`. The cluster stack keeps them as a secret in its stack
file, so no name is committed in plain text. Removing a name revokes that membership on the next apply. The group is
protected and kept when the stack is destroyed, because every product's databases are granted to it; the member grants
are not protected, so a removal goes through. `adoptExisting` imports a group that already exists, for the handover
below; a program takes one `Operators`, and a second is refused, naming the first.

On PostgreSQL 16+ a `REVOKE` removes only the membership row the revoking role granted; for a row another role
granted it prints a warning and leaves the membership in place. So every member's row must be the cluster admin's own.
Before it registers anything, the cluster program reads the group's memberships: one that gives access, was granted
by another role, and belongs to a name not on its list is refused, naming the role that can revoke it; one for a name
on the list is a warning, because removing that name later would not take it away.

Grant by hand only in an emergency, as the cluster admin, and add the name to the list on the next apply:

```sql
GRANT pebble_operators TO "<their role>";
```

Never grant it `WITH ADMIN OPTION` to a person: a membership they grant is one only they can revoke.

### A second product on a cluster

The group belongs to the cluster, and the cluster's operators program holds it and its list. A second product on a
cluster constructs no `Operators`. Its `Database` grants its owner to the existing group with the product's own admin,
which holds nothing on the group: granting a role it created needs ADMIN OPTION on that role only. Its people are added
to the cluster stack's `members`.

A product stack that constructs `Operators` on a cluster whose group exists fails at apply creating it
(`role "pebble_operators" already exists`). A product stack that keeps its 0.3.x `Operators` after the handover goes on
granting with the product's admin; the cluster stack then refuses any of those memberships that its list does not
hold, so two lists never disagree silently.

### The 0.3.x form, until the handover

Until a cluster's operators program has taken the group over, the product whose stacks created it keeps its 0.3.x
`Operators` (`stage`: `shared` for the staging cluster, `prod` for the production cluster) and its list is the
cluster's list. This form still works unchanged. The handover moves the group and every membership to the cluster
stack with no gap in anyone's access, then removes `Operators` from the product's stacks without deleting the group:
[cluster-operators README, "Hand the group over"](../../cluster-operators/README.md#hand-the-group-over). Afterwards
the product's `shared` stack needs no admin URL: drop `shared` from its `pgAdminUrl` entry.

## Errors alarm

`ApiFunction` creates one CloudWatch alarm, `<product>-<env>-<kind>-errors`, on the function's Lambda `Errors`
metric. `Errors` counts what an error tracker inside the handler cannot report: a crash before the handler's code
runs (an import or cold-start failure), a timeout, an out-of-memory kill, a runtime failure. An error the handler
catches and answers with a 500 is a successful invocation to Lambda, so it is not counted; that one is the error
tracker's.

| Argument | Default |
|---|---|
| `alarm.topicArn` | none: the alarm changes state in CloudWatch and notifies no one |
| `alarm.threshold` | `1`: one error sets it off |
| `alarm.period` | `300` seconds, a multiple of 60; one period is evaluated |
| `alarm: false` | creates no alarm. On a prod stack whose alarm is already applied, follow [Remove an applied prod alarm](#remove-an-applied-prod-alarm) |

The sum of `Errors` over the period is compared with `>=`. Lambda publishes `Errors` only for periods with
invocations, so a function with no traffic has no data; missing data counts as not breaching, so a quiet function stays
`OK` rather than going to `INSUFFICIENT_DATA` or alarming. On prod the alarm is protected and retained like every
other child.

`topicArn` is the account bootstrap's `alarmTopicArn` output ([bootstrap](https://github.com/pebble-tech/toolkit/tree/main/bootstrap)):
one SNS topic per AWS account, emailing the address its config names once that address confirms the subscription. A
product passes it through its entries module, stored per GitHub environment because the ARN holds the account id:

```ts
// entries.ts
{ key: 'alarmTopicArn', env: 'ALARM_TOPIC_ARN', secret: false, required: true, stacks: ['staging', 'prod'] },

// the program
new ApiFunction('api', { stage, code, domain, alarm: { topicArn: config.require('alarmTopicArn') } });
```

### Upgrade to 0.4

The deploy role creates the alarm (`DeployRole`'s `Alarms` statement, below). A role applied from 0.3.x lacks it, and a
product's `infra/bootstrap` builds its role from the package version it has installed, so re-applying that bootstrap
while 0.3.x is still installed changes nothing. "Bumping" here means the dependency change landing in a release, the
first run that applies the runtime stacks with 0.4. Before that release, in this order:

1. On the upgrade branch, install 0.4 (`pnpm --dir infra add --save-exact @pebbletech/infra@next` until 0.4.0 is out)
   and rebuild `infra/` (`pnpm --dir infra build`). Do not merge yet.
2. From that build, with SSO, apply the product's `infra/bootstrap` `staging` and `prod` stacks. Each preview shows an
   update to the role's inline policy (`deploy`) and nothing else. The role only gains permissions, so a 0.3.x release
   that runs in between still works.
3. Apply the account bootstrap with `alarmEmail` set
   ([bootstrap](https://github.com/pebble-tech/toolkit/tree/main/bootstrap), "Add the alarm topic to an applied
   stack"), and click the link in AWS's confirmation email.
4. Wire the topic: store each account's `alarmTopicArn` as a secret of the GitHub environments that deploy there, add
   the entry, and pass `alarm: { topicArn }` to each `ApiFunction`, on the same branch.
5. Only then merge and release, so the runtime stacks apply with the new role already in place. Releasing first fails
   the first `up` on `cloudwatch:PutMetricAlarm`.

### Remove an applied prod alarm

`alarm: false` before the alarm is first created means it is never created. Once a prod stack has applied it, the alarm
is protected and retained like every prod child. Then `alarm: false`, or a rollback to 0.3.x (which does not declare
the alarm), fails the release with `cannot be deleted because it is protected`. Unprotecting alone is not enough:
removal then shows `delete[retain]`, which drops the alarm from the state and leaves it running in CloudWatch. To remove
it, with prod admin SSO and `pulumi login` to the prod stack's backend, right before the release that removes it:

```sh
pulumi stack --show-urns -s prod | grep metricAlarm   # the alarm's URN, ending in ::<name>-errors
pulumi state unprotect '<urn>' -s prod
pulumi state delete '<urn>' -s prod
```

Then release the change (`alarm: false`, or the 0.3.x pin). Its preview shows nothing for the alarm. Last, delete the
alarm in the prod account: `aws cloudwatch delete-alarms --alarm-names <product>-prod-<kind>-errors`. If a release
that still declares the alarm runs between the state delete and that change, it creates the alarm again; repeat the
steps. On staging and previews the alarm is not protected, so `alarm: false` or a rollback deletes it. A full rollback
reverts the runtime stacks first and the role bootstraps last: a role re-applied from 0.3.x can no longer delete the
alarms a later release would remove.

## Ownership

- `shared`: the Vercel project and its custom environments. Apply it before `staging`, `prod` and previews. It has no
  deploy role of its own. The staging role applies it, so its state lives at `<product>/shared` in
  `pebble-stg-pulumi-state` and its secrets use the staging key (`stateKeyAlias('shared')` is
  `alias/pebble-stg-pulumi-staging`). Until the handover, the product that created a cluster's group also applies the
  staging cluster's `Operators` here ([The 0.3.x form](#the-03x-form-until-the-handover)).
- `pr-<n>`: a database and its owner role, created by the product's preview admin. Previews pass env to
  `vercel deploy`.
- `staging`, `prod`: database, its owner role and the runtime role's grants (the runtime role itself is
  PlanetScale's), API, Worker, web env vars and domain, with the product's admin. Until the handover, `prod` of the
  product that created the production cluster's group also applies its `Operators`.
- `infra/bootstrap` (a separate project, applied by hand with SSO): one `DeployRole` per env (`preview`, `staging`,
  `prod`). `ApiFunction` defaults its boundary to `<product>-<env>-boundary` in the current account, the policy the
  deploy role created.
- Not the product's: each AWS account's bootstrap ([bootstrap/](../../bootstrap/README.md)) and each cluster's
  `pebble_operators` ([cluster-operators/](../../cluster-operators/README.md)), both applied by hand.

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

A staging or prod deploy role manages CloudWatch alarms named `<product>-<env>-*` (`PutMetricAlarm`, `DeleteAlarms`,
`TagResource`, `UntagResource`, `ListTagsForResource`) and may read every alarm's configuration in the account
(`DescribeAlarms` on `*`).

`DeployRole` gates `iam:PassRole` on `iam:PassedToService` alone (PassRole has no boundary condition key); the boundary
is enforced where roles are written: `CreateRole`, `AttachRolePolicy`, `PutRolePolicy` and
`PutRolePermissionsBoundary` on `role/<product>-<env>-*` require the env's boundary, and `DeleteRolePermissionsBoundary`
is denied.

## Credentials and ownership

Every Postgres role belongs to the admin that created it. On PostgreSQL 16+ a non-superuser that creates a role is
granted ADMIN OPTION on it by the bootstrap superuser, so it alone can grant the role, act as it and drop it, and no
other admin can take that away. A membership belongs to the role that granted it: only that role revokes it. Kong
mints every admin; the roles a stack creates belong to whichever admin the stack's `adminUrl` names. Hence:

- **One admin per product per cluster.** A product's `staging`, `prod` (and, in the 0.3.x form, `shared`) stacks use
  its admin on that cluster, a PlanetScale role inheriting `postgres` (CREATEDB and CREATEROLE). It owns, through the
  roles it created, every database the product has there.
- **A separate preview admin**, used only by `pr-<n>` stacks, in the `preview` GitHub environment and nowhere else.
  It holds nothing on the staging database's owner role, so a preview credential can create and drop preview
  databases and cannot act as staging's owner.
- **The cluster admin**, used only by the cluster's operators program, held by Kong, never in a GitHub environment. It
  holds ADMIN OPTION on `pebble_operators` with no access through it, and no right on any product's database.
- **Never share an admin across products.** An admin can act as every role it created, so a shared admin gives each
  product the other's databases.
- **Replace a password, not an admin.** A new admin role cannot act as, grant or drop the roles the old one created,
  and the old one cannot be dropped while a grant it made still stands (Postgres refuses, naming the membership).
  `pebble-infra` refuses to drop a preview whose role another admin created, naming that admin. On a cluster whose
  group a product's admin created, the cluster admin's ADMIN OPTION rests on that admin's grant: never run
  `DROP OWNED BY` it or `REVOKE ... CASCADE` from it, which take that ADMIN OPTION and the databases' grants to the group
  ([cluster-operators README](../../cluster-operators/README.md#replace-an-admin)).

Moving a product's previews to a new preview admin while previews are open leaves each open one to the old admin: the
close job refuses it and names the admin that can drop it. Switch when no preview is open, or keep the old admin's URL
until the open ones close.

### Mint a product's admins

Kong, once per product and cluster, with the `pscale` CLI. The first two are on the staging cluster, the third on the
production cluster; `<product>` is the product id:

```sh
url() { jq -r '"postgresql://\(.username):\(.password | @uri)@\(.access_host_url):5432/postgres?sslmode=verify-full"' <<<"$1"; }
preview="$(pscale role create pebble-stg main <product>-preview-admin --org pebble-tech --inherited-roles postgres --format json)"
staging="$(pscale role create pebble-stg main <product>-admin --org pebble-tech --inherited-roles postgres --format json)"
production="$(pscale role create pebble-prd-shared main <product>-admin --org pebble-tech --inherited-roles postgres --format json)"
url "$preview" | gh secret set PG_ADMIN_URL --env preview --repo pebble-tech/<repo>
url "$staging" | gh secret set PG_ADMIN_URL --env staging --repo pebble-tech/<repo>
url "$production" | gh secret set PG_ADMIN_URL --env production --repo pebble-tech/<repo>
unset preview staging production
```

Check each, connected with its URL: `select current_user, rolcreatedb, rolcreaterole, rolsuper from pg_roles where
rolname = current_user` shows `t`, `t`, `f`, and `current_user` is the username without its `.<branch>` suffix. These
are assumptions from the first product's cutover (an admin inheriting `postgres` has CREATEDB and CREATEROLE); check
them on the first admin you mint. Keep each URL in the password manager: a lost password is reset on the same role, never replaced
by a new one.

## Use it

A product's repository holds only what is about that product: its `infra/` program, its entries module, its own
workflow files and its runbook. The toolkit decides no job graph and no trigger; it ships the pieces below, which a
product composes in this order.

1. **Install** the package in `infra/`, a package of the product's pnpm workspace, and pin it exactly. Until 0.4.0 is
   out, install the `next` tag, the 0.4.0-next.N prerelease: `latest` is 0.3.2, which has no `pebble-infra`.
   `--save-exact` records the exact prerelease version.

   ```sh
   pnpm --dir infra add --save-exact @pebbletech/infra@next @pulumi/pulumi
   ```

   Use pnpm. `@pulumi/pulumi` declares `typescript <7` as an optional peer; pnpm warns, but npm refuses to install it
   next to TypeScript 7, so npm users need an `overrides` entry or `--legacy-peer-deps`.
2. **Write the program** from the components above, and export what the workflows read as `outputs`, which
   `pebble-infra` reads by default. Compile it with `tsc` ([Precompile the program](#precompile-the-program)).

   ```ts
   import { Database, Stage } from '@pebbletech/infra';
   import * as pulumi from '@pulumi/pulumi';

   const config = new pulumi.Config();
   const stage = new Stage('stage', { product: 'basefresh' });
   const db = new Database('db', { stage, adminUrl: config.requireSecret('pgAdminUrl') });
   export const outputs = { databaseUrl: db.directUrl };
   ```
3. **List its config once**, in the entries module ([The entries module](#the-entries-module)): every stack config
   value, the variable it comes from, and the stacks that need it.
4. **Run the stack steps with `pebble-infra`**, from `infra/`'s own `node_modules`, never through `npx`
   ([Run the stack steps](#run-the-stack-steps)): `outputs` before `up` to migrate first, `up`, `preview`, `remove`.
5. **Write the workflows.** Each deploying job runs the `setup` action, a visible
   `aws-actions/configure-aws-credentials` step, then `pebble-infra` lines or the optional `pulumi` action
   ([Workflow actions](#workflow-actions)). The web-only production workflow below is one to start from.
6. **Check them in a test** with `checkWorkflows` from `@pebbletech/infra/testing`, experimental in 0.4
   ([Check the workflows](#check-the-workflows)), with the product's GitHub environment secrets as data.
7. **Wire the alarm topic** if the program has an `ApiFunction`: each account bootstrap's `alarmTopicArn`, stored per
   GitHub environment and passed as `alarm: { topicArn }` ([Errors alarm](#errors-alarm)). Without it the alarm
   notifies no one. A product on 0.3.x first follows [Upgrade to 0.4](#upgrade-to-04).
8. **Leave `pebble_operators` to the cluster.** A product program constructs no `Operators`; its people are added to the
   cluster operators program's list ([Operators](#operators)). On a fresh cluster that program is applied before any
   product stack.
9. **Keep the pins in step** with one Renovate group for the package and the action SHAs ([Renovate](#renovate)).

Before the first deploy, Kong mints the product's admins ([Mint a product's admins](#mint-a-products-admins)) and the
product's `infra/bootstrap` (a `DeployRole` per env) is applied by hand with SSO ([Ownership](#ownership)). Each AWS
account's bootstrap and each cluster's operators program already exist; neither belongs to the product.

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

Build `infra/` (`tsc -p infra`, or its `build` script) before any `pebble-infra` step: they run the compiled program and
import the compiled entries module. Bundles (`ApiFunction.code`, `Worker.script`) come from the product's own build;
the components never bundle.

### A web-only production workflow

A product whose only app is a Vercel web app on a database: `shared` owns the Vercel project, `pr-<n>` a database, and
`staging` and `prod` a database and the web app's env vars and domain. This is its whole production workflow:
migrate, `pulumi up`, then the web deploy.

<!-- examples/web-only/.github/workflows/deploy-production.yml -->
```yaml
name: Deploy production

# Each published release: migrate prod's database, `pulumi up` prod, then deploy the web app to Vercel's production
# target. The database is migrated before `up`, except on the first release, when there is none yet: then right after.

on:
  release:
    types: [published]

permissions:
  contents: read

env:
  APEX: pebbletech.my

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    # The only job on prod, and the one that clears its lock (`clear-lock`). Never cancel: a cancelled `pulumi up` leaves
    # its lock and can leave an operation half done. Any other job on prod joins this group, with `queue: max`.
    concurrency:
      group: pulumi-prod
      cancel-in-progress: false
    permissions:
      contents: read
      id-token: write
    env:
      PULUMI_BACKEND_URL: s3://pebble-prd-pulumi-state/notes/prod?region=ap-southeast-1
      PULUMI_SECRETS_PROVIDER: awskms://alias/pebble-prd-pulumi-prod?region=ap-southeast-1
    steps:
      - name: Checkout
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6

      # Pin both toolkit actions at the commit tagged @pebbletech/infra@<the version infra/ installs>.
      - name: Set up pnpm, Node.js, the dependencies and the Pulumi CLI
        uses: pebble-tech/toolkit/.github/actions/setup@0000000000000000000000000000000000000000 # @pebbletech/infra@0.4.0

      - name: Build the infra program
        run: pnpm --dir infra build

      - name: Assume the prod deploy role
        uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-southeast-1

      - name: Prod's database URL, before up (nothing before the first release)
        id: before
        run: |
          pulumi login "$PULUMI_BACKEND_URL"
          pnpm --dir infra exec pebble-infra outputs prod --github-output --if-exists

      - name: Migrate prod
        if: steps.before.outputs.database_url != ''
        env:
          DATABASE_URL: ${{ steps.before.outputs.database_url }}
        run: pnpm db:migrate

      - name: Pulumi up (prod)
        id: up
        uses: pebble-tech/toolkit/.github/actions/pulumi@0000000000000000000000000000000000000000 # @pebbletech/infra@0.4.0
        env:
          PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}
        with:
          command: up
          stack: prod
          entries: dist/entries.js
          clear-lock: true

      - name: Migrate prod's new database (first release)
        if: steps.before.outputs.database_url == ''
        env:
          DATABASE_URL: ${{ fromJSON(steps.up.outputs.json).database_url }}
        run: pnpm db:migrate

      # The prod stack has set the project's production env vars and domain; this builds and deploys the app.
      - name: Deploy the web app to Vercel (production)
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_TEAM_ID }}
          VERCEL_PROJECT_ID: ${{ fromJSON(steps.up.outputs.json).project_id }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_API_TOKEN }}
        run: |
          pnpm exec vercel pull --scope "$VERCEL_ORG_ID" --yes --environment=production --token "$VERCEL_TOKEN"
          pnpm exec vercel build --scope "$VERCEL_ORG_ID" --prod --token "$VERCEL_TOKEN"
          pnpm exec vercel deploy --scope "$VERCEL_ORG_ID" --prebuilt --prod --yes --token "$VERCEL_TOKEN"
```

What it assumes of the product:

- `infra/`'s `build` script compiles the program to `dist/`, with the entries module at `dist/entries.js`
  ([`examples/web-only/src/entries.ts`](https://github.com/pebble-tech/toolkit/tree/main/examples/web-only/src/entries.ts)),
  and the prod stack exports `databaseUrl` and `projectId`.
- The root `package.json` has a `db:migrate` script reading `DATABASE_URL`, and `vercel` as a dev dependency.
- The `production` GitHub environment sets `AWS_DEPLOY_ROLE_ARN`, `PG_ADMIN_URL`, `PG_RUNTIME_ROLE`,
  `PG_RUNTIME_PASSWORD`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `VERCEL_API_TOKEN` and `VERCEL_TEAM_ID`.
- The toolkit's two actions are pinned at the commit tagged `@pebbletech/infra@<version>` for the exact version
  `infra/` installs: on each `uses:` line, replace both the all-zero SHA and the `# @pebbletech/infra@0.4.0` comment,
  which Renovate reads as the current version. While 0.4 is a prerelease the tag and the comment are
  `@pebbletech/infra@0.4.0-next.N`.

[`examples/web-only`](https://github.com/pebble-tech/toolkit/tree/main/examples/web-only) holds this workflow, its
program and the test that runs `checkWorkflows` on it. [`examples/basefresh`](https://github.com/pebble-tech/toolkit/tree/main/examples/basefresh)
is the fuller reference: previews, staging with `shared`, a preview of prod on every push, an API, a Worker and a
read-only smoke.

## Run the stack steps

The package ships `pebble-infra`, the steps a workflow runs around `pulumi up`. Run it from the product's own
`node_modules`, in the directory holding `Pulumi.yaml`, after `pulumi login`:

```sh
pnpm --dir infra exec pebble-infra up staging --entries dist/entries.js --clear-lock
```

| Command | Does |
|---|---|
| `prepare <stack> [--clear-lock] [--entries <module>]` | selects the stack, or creates it with `PULUMI_SECRETS_PROVIDER`; restores its secrets key from the state on a fresh checkout; starts a preview again from nothing when an interrupted run left only its Stage and database. A `pr-<n>` stack needs `--entries`, for `previewDatabase`; `--preview-only` (next row) does not |
| `prepare <stack> --preview-only` | selects the stack and restores its key; never clears a lock, creates, removes or resets, and refuses a stack that is missing, never updated or has pending operations |
| `configure <stack> --entries <module>` | writes the stack config from the product's entries module; values go to Pulumi through stdin |
| `up <stack> --entries <module> [--clear-lock] [--outputs <name>]` | `prepare`, `configure`, `pulumi up` (previews with `--refresh`, tried again twice on a template1 collision), then the outputs to `$GITHUB_OUTPUT` when it is set |
| `preview <stack> --entries <module> [--summary]` | `prepare --preview-only`, `configure`, `pulumi preview --diff`; `--summary` appends the diff to `$GITHUB_STEP_SUMMARY` |
| `outputs <stack> [--github-output] [--if-exists] [--outputs <name>]` | prints the stack's `outputs` export with secrets hidden, or writes it to `$GITHUB_OUTPUT`; `--if-exists` exits 0 with nothing when the stack or the export does not exist yet (read before `up` to migrate first) |
| `remove pr-<n> --entries <module> [--clear-lock]` | destroys a preview, drops its database and role (with `previewDatabase`), removes the stack and deletes every state object it left under the S3 backend path. When the destroy fails and the state still holds anything beyond the Stage and database (a `Worker` whose delete was refused), it stops naming the types and keeps the state for another `remove` |
| `pg-database <drop\|check> <name> [--owner <role>]` | drops a database and its role with `PG_ADMIN_URL`, or exits 3 naming the admin that could |

- **Product id**: `Pulumi.yaml`'s `name`, or `--product`. The preview database is `<product>_pr_<n>`, the name
  `Database` gives it.
- **Preview database**: only an entries module that exports `previewDatabase = true` makes the `pr-<n>` steps reach
  Postgres: `prepare` drops a database an earlier run left before it creates the stack and checks before `up` that
  `PG_ADMIN_URL`'s admin could drop it, and `remove` drops it. Without it they never touch Postgres and need no
  `PG_ADMIN_URL`.
- **Locks**: only `--clear-lock` runs `pulumi cancel`; `preview` and `prepare --preview-only` never clear a lock. A
  long-lived stack (`shared`, `staging`, `prod`) is cleared only by jobs in one concurrency group that is never
  cancelled, shared by every job on that stack, preview jobs included. On a `pr-<n>` stack every job, `remove`
  included, shares the pull request's one group, which may cancel in progress: the lock a cancelled run leaves belongs
  to that group, and its next `up` or `remove` clears it.
- **Preview reset**: a `pr-<n>` stack with pending operations or no resources is removed and created again only when
  it holds nothing beyond its Stage and, with `previewDatabase`, the database closure (`postgresql`, `random`,
  `Database`). Anything else (a `Worker`, a Vercel project) stops `prepare` by type, for `pulumi refresh` or
  `remove`.
- **Outputs**: each key of the export becomes a step output in snake case (`databaseUrl` → `database_url`). Every
  secret value is masked with `::add-mask::` before anything is written, escaped as `core.setSecret` escapes it, and
  each line of a multi-line value is masked too; multi-line values use the heredoc form.
- **Environment**: `PULUMI_BACKEND_URL` and `PULUMI_SECRETS_PROVIDER` for `prepare`, `up`, `preview` and `remove`;
  `PG_ADMIN_URL` for preview stacks with `previewDatabase`; `aws` on `PATH` for `remove`.

### The entries module

Every stack config value the program reads, listed once. `configure` imports the compiled module and writes each
entry; the program reads each key itself with Pulumi's `Config` (`config.get`, `getSecret`, `require`), as
[`examples/web-only/src/index.ts`](https://github.com/pebble-tech/toolkit/tree/main/examples/web-only/src/index.ts)
does:

```ts
// infra/src/entries.ts
import type { ConfigValues, Entry } from '@pebbletech/infra';

const RUNTIME = ['staging', 'prod'] as const;
export const entries: Entry[] = [
  { key: 'aws:region', env: 'AWS_REGION', secret: false, required: true, stacks: ['shared', 'preview', ...RUNTIME] },
  { key: 'pgAdminUrl', env: 'PG_ADMIN_URL', secret: true, required: true, stacks: ['preview', ...RUNTIME] },
  { key: 'pgRuntimeUrl', env: 'DATABASE_RUNTIME_URL', secret: true, required: true, stacks: RUNTIME },
  { key: 'pgRuntimeRole', env: 'PG_RUNTIME_ROLE', secret: false, required: true, stacks: RUNTIME },
];

/** Values computed from the others: the runtime role is the URL's username without its `.branch`. */
export function derive(values: ConfigValues): ConfigValues {
  const user = values.DATABASE_RUNTIME_URL && decodeURIComponent(new URL(values.DATABASE_RUNTIME_URL).username);
  return user ? { PG_RUNTIME_ROLE: user.split('.')[0] } : {};
}

/** The program creates a `Database` on `pr-<n>` stacks. */
export const previewDatabase = true;
```

A key without a namespace goes in the product's (or the module's `namespace` export). `aws:region` has no default:
it is an entry like any other. A missing required value stops `configure` naming every missing variable; a set but
blank optional value removes its key, so a value from an earlier run cannot linger.

Values come from `PEBBLE_INFRA_VALUES` first, when it holds a JSON object (in a workflow,
`PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}`), then from the environment. Invalid JSON or anything but an object of
strings is refused without repeating it, and no child process (Pulumi, `aws`, the database script) gets the variable.
`PG_ADMIN_URL` is read the same way.

## Workflow actions

The toolkit repo ships two composite actions for a product's own workflows. Pin each by the full SHA of the commit
tagged `@pebbletech/infra@<version>`, for the version `infra/` installs, with that version in a comment, and keep the
SHA and `@pebbletech/infra` in step ([Renovate](#renovate)):

```yaml
- uses: pebble-tech/toolkit/.github/actions/setup@<40-character SHA> # @pebbletech/infra@0.4.0
```

They decide no job graph and no trigger, and they never assume a role: AWS credentials stay a visible
`aws-actions/configure-aws-credentials` step in the product's workflow.

### setup

One step in place of the five every deploying job repeats: pnpm from `packageManager`, Node.js from `.nvmrc`,
`pnpm install --frozen-lockfile`, the Pulumi CLI and its plugin cache. It also sets `GITHUB_TOKEN` to the job's token
for Pulumi's plugin downloads, unless the job sets one.

The CLI version is the version of the `@pulumi/pulumi` the product installed, read from `infra` after the install.
That package is the one source: Renovate bumps it, and the CLI follows, so the CLI never drifts from the SDK the program
runs with. No input sets a version. Setup stops, naming the package, when `infra` has no `@pulumi/pulumi` installed.
The plugin cache key holds that version and the lockfile's hash.

| Input | Default | |
|---|---|---|
| `infra` | `infra` | the directory, from the repository root, whose installed `@pulumi/pulumi` sets the version |
| `pulumi` | `true` | `false` skips the CLI, its cache and the token, for a job that never runs `pulumi` (a smoke) |

### pulumi

Optional: a `uses:` step in place of a `run:` line, for `up`, `preview` and `remove`. It runs
`pnpm --dir <infra> exec pebble-infra <command> <stack> --entries=<entries>` with `--clear-lock` and `--summary` when
set, from the product's own `node_modules`, after `pulumi login "$PULUMI_BACKEND_URL"` when that is set. Every input
reaches `pebble-infra` as one argument. It stops before running anything when the installed `@pebbletech/infra`'s
major.minor is not the action's own: pin the action at the commit of the version the product installs. Read the URL
before `up` with a `run:` line (`pebble-infra outputs <stack> --github-output --if-exists`), as below.

```yaml
- name: Pulumi up (prod)
  id: up
  uses: pebble-tech/toolkit/.github/actions/pulumi@<40-character SHA> # @pebbletech/infra@0.4.0
  env:
    PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}
  with:
    command: up
    stack: prod
    entries: dist/entries.js
    clear-lock: true
- name: Migrate prod's new database (first release)
  if: steps.before.outputs.database_url == ''
  env:
    DATABASE_URL: ${{ fromJSON(steps.up.outputs.json).database_url }}
  run: pnpm db:migrate
```

A composite action cannot pass on outputs it does not name, so the action has one: `json`, every output `pebble-infra`
wrote, keyed as it wrote them. Read `fromJSON(steps.<id>.outputs.json).<name>`, never `steps.<id>.outputs.<name>`.
Inputs: `command`, `stack`, `entries` (all required), `clear-lock` and `summary` (`true` or `false`), `infra` (default
`infra`). The step's `env:` reaches `pebble-infra` as on a `run:` line.

### Renovate

The package and the two action pins move together: one Renovate group. The pins need a custom regex manager, because
Renovate's GitHub Actions manager reads a version comment only as a plain version (`# v1.2.3`, `# tag=v1.2.3`), not as
`# @pebbletech/infra@1.2.3`; left to it, a SHA with no version it can read would follow the toolkit's default branch.
The regex manager reads the SHA and the version from the toolkit's release tags (`@pebbletech/infra@<version>`), and
rewrites both together.

The Pulumi CLI needs no manager of its own: `setup` installs the version of the `@pulumi/pulumi` the product installed,
which Renovate's npm manager already bumps.

```json
{
  "customManagers": [
    {
      "customType": "regex",
      "managerFilePatterns": ["/^\\.github/workflows/[^/]+\\.ya?ml$/"],
      "matchStrings": [
        "uses: pebble-tech/toolkit/\\.github/actions/[a-z-]+@(?<currentDigest>[0-9a-f]{40}) # @pebbletech/infra@(?<currentValue>\\S+)"
      ],
      "depNameTemplate": "@pebbletech/infra",
      "packageNameTemplate": "pebble-tech/toolkit",
      "datasourceTemplate": "github-tags",
      "versioningTemplate": "npm",
      "extractVersionTemplate": "^@pebbletech/infra@(?<version>.+)$"
    }
  ],
  "packageRules": [
    { "matchManagers": ["github-actions"], "matchPackageNames": ["pebble-tech/toolkit"], "enabled": false },
    { "matchDepNames": ["@pebbletech/infra"], "groupName": "@pebbletech/infra" }
  ]
}
```

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

### Check the workflows

Experimental in 0.4: the rules and the subset it reads may change in a minor release. It catches mistakes in a
workflow written in good faith; it is not a security boundary. Two known gaps, both passing when they should fail:
- a literal `strategy.matrix` whose `include` adds two entries on the same stack is read as one copy, so the `lock`
  rule does not see the two copies run at once;
- a secret read after a `}}` inside a quoted string in the same expression, such as
  `${{ format('{{"t":"{0}"}}', secrets.TOKEN) }}`, is not checked against the table.

`checkWorkflows` reads the product's own workflow files and returns every violation, each naming its job
(`<file>#<job>`) and rule; a product's test expects none. It checks rules, never a job graph or a trigger. It reads
a narrow subset of workflow text, below, and fails on anything outside it rather than guess:

```ts
import { checkWorkflows } from '@pebbletech/infra/testing';
import * as entries from './entries.js';

expect(
  checkWorkflows({
    workflows: ['preview.yml', 'deploy-staging.yml', 'deploy-production.yml'].map((f) => `../.github/workflows/${f}`),
    product: 'basefresh',
    region: 'ap-southeast-1',
    entries,
    // Every secret set in each GitHub environment: data, kept next to the test.
    secrets: { preview: ['AWS_DEPLOY_ROLE_ARN', 'PG_ADMIN_URL'], staging: [/* … */], production: [/* … */] },
    roleSecret: 'AWS_DEPLOY_ROLE_ARN',
    database: { output: 'database_url', stacks: ['preview', 'staging', 'prod'] },
    // What the module's derive writes, and the variables it reads to do so.
    derived: { PG_RUNTIME_ROLE: ['DATABASE_RUNTIME_URL'] },
  })
).toEqual([]);
```

| Rule | A job breaks it when |
|---|---|
| `stack` | the stack a `pebble-infra` step names is not one of the forms below and is not declared; a job holding state (`PULUMI_BACKEND_URL` or a credentials step) runs a local `uses: ./…` action or `pulumi/actions`; a step runs a toolkit action other than `setup`, or the `pulumi` action with an input that is not a literal; a job on a stack has a `strategy.matrix` that is not a literal mapping; the checked workflows touch both a literal `pr-<number>` and the PR form; or a step runs `pulumi` directly, with or without global flags before the subcommand (other than `login`) |
| `state` | it touches a stack outside the GitHub environment that stack's deploy role trusts (`production` for `prod`, `staging` for `shared`); before a `configure-aws-credentials` step whose `role-to-assume` is exactly `${{ secrets.<roleSecret> }}`; or with a `PULUMI_BACKEND_URL` or `PULUMI_SECRETS_PROVIDER` other than that stack's (`deployState`) |
| `secrets` | anywhere in the job as written a `${{ }}` reads `secrets.X` that its environment does not set, or names `secrets` in any other way (brackets, spaces, a computed name) except the whole expression `${{ toJSON(secrets) }}`; a step with `PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}` runs `configure`, `up` or `preview` and a required entry is unset (or `PG_ADMIN_URL`, on a `pr-<n>` stack with `previewDatabase`); the table lists a secret no job reads; or the module exports `derive` and the test gives no `derived` |
| `lock` | a `preview` or `prepare --preview-only` passes `--clear-lock`; on a long-lived stack whose lock a job clears, a job holds a group another job on it does not, holds an expression as its group, or may be cancelled in progress (its own group or the workflow's); a job on one `pr-<n>` stack holds another group than the other jobs on that stack; two jobs of one run on one stack, matrix copies included, share only the workflow's group with no `needs` between them (or, for copies, no `max-parallel: 1`) |
| `concurrency` | a long-lived stack whose lock a job clears is touched by more than one job, and a job's group does not set `queue: max` (a newer run would drop a pending one) |
| `migrate` | it runs `up` on a stack in `database.stacks` without the migrate-first shape below in the same job, or with any other condition on its steps, `up`'s included |

What the helper reads, and nothing else. It never works out what a non-literal value will be:
- **Expressions**: a value is an expression only inside `${{ }}`; bare text is literal, so `role-to-assume:
  secrets.ROLE` and `PEBBLE_INFRA_VALUES: toJSON(secrets)` are literal strings and fail. Only an `if:` may leave out
  its `${{ }}`.
- **Stack**: the stack argument written in the `pebble-infra` command: `shared`, `staging`, `prod`, `pr-<number>`, or
  `"pr-${{ github.event.pull_request.number }}"` (quoted, so the shell sees one word). A variable such as
  `"$PULUMI_STACK"` is not read, whatever its `env:` says. A literal `strategy.matrix` (lists, `include`, `exclude`)
  is written into each copy of the job; any other matrix refuses. Anything else, and a local action in a job holding
  state, needs a declaration: `stacks: { 'release.yml#deploy': ['prod'] }`. A declared local action is taken to clear
  the lock.
- **The pulumi action**: a step whose `uses:` is `pebble-tech/toolkit/.github/actions/pulumi@<any ref>` (the owner and
  repo in any case, as GitHub matches them; the path exactly; a ref may hold `/`) is read as the `pebble-infra` command
  its `with:` makes: a literal `command` (`up`, `preview` or `remove`), a stack in one of the forms above, a literal
  `entries` (required) and `infra`, and `clear-lock` and `summary` written as `true` or `false`. Any other input,
  value or path under `pebble-tech/toolkit/` (other than `setup`) refuses, naming the step. Every rule then reads it as
  the `run:` line it stands for.
- **Group**: on a long-lived stack, a literal string; on a PR stack, a literal or one keyed only on
  `${{ github.event.pull_request.number }}`. Groups are compared per stack, so each PR stack has its own. Workflows
  that use both a literal `pr-<number>` and the PR form refuse, since the two can be one stack.
- **Values**: a required entry is set by a non-blank step, job or workflow env value, by the environment's table when
  the step has `PEBBLE_INFRA_VALUES: ${{ toJSON(secrets) }}`, by `AWS_REGION` after a credentials step with
  `aws-region`, or, for a variable named in `derived`, only when all its sources are set. `derive` itself never runs.
- **Migrate first**: in the job that runs `up`, `pebble-infra outputs <stack> --github-output --if-exists` with an
  `id` and no `if:` comes before `up`; a read in another job does not count. Every step between it and `up` that
  reads the URL runs under exactly `if: steps.<id>.outputs.<output> != ''`, and a step after `up` (which has an `id`)
  runs under exactly `if: steps.<id>.outputs.<output> == ''` and reads `steps.<up id>.outputs.<output>` (after the
  `pulumi` action, `fromJSON(steps.<up id>.outputs.json).<output>`). That pair
  marks the first deploy, when there is no stack before `up` and the read writes nothing. `up` itself has no `if:`. A
  step reads an output only inside `${{ }}` and outside a quoted string: `DATABASE_URL: steps.up.outputs.database_url`
  without `${{ }}`, or `${{ 'steps.up.outputs.database_url' }}`, reads nothing. `${{ }}` around a guard and its spacing
  do not matter; any other condition fails.

`examples/basefresh/.github/workflows` holds three workflows written this way, and `examples/web-only` one. `loadWorkflow(path)` returns one
parsed workflow, for checks of the product's own (the jobs a release run holds, say). The helper and `yaml` load only
through `@pebbletech/infra/testing`.
