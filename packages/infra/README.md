# @pebbletech/infra

Pulumi components for a Pebble product's `infra/` program. A product gets previews, staging and production by
pinning a version; the guardrails are defaults it cannot turn off.

| Component | Creates | Refuses |
|---|---|---|
| `Stage` | nothing; parses the stack name and names, tags and protects everything else | a product id that is not one DNS label, starts with `pebble`, or is `pr`/`staging`/`prod`/`shared`; a kind that is not one DNS label; any stack other than `pr-<n>`, `staging`, `prod`, `shared` |
| `VercelProject` | `shared`: the project (no Git connection, private source, Vercel Authentication on previews), custom environments, the protection bypass. `staging`/`prod`: env vars (secrets `sensitive`), the domain bound to the stage's environment, an unproxied Cloudflare CNAME | previews; the project outside `shared`; env vars or domains on `shared`; a secret-looking name in `vars` |
| `Database` | an explicit Postgres provider on port 5432 with `sslmode=verify-full`, the database, its owner (a generated login role on previews), the `public` revoke; `directUrl` and `pooledUrl` as secrets | staging/prod without an existing owner role; a derived name longer than 63 characters. The name is always `stage.databaseName()` |
| `ApiFunction` | Lambda `nodejs22.x` from a prebuilt bundle, log group (30 days), role with the permissions boundary and only `AWSLambdaBasicExecutionRole`, HTTP API without the execute-api endpoint, regional ACM certificate validated in Cloudflare, custom domain, CNAME | no domain; a boundary other than the stage's own `<product>-<env>-boundary` in the current account (a typed `PermissionsBoundaryArn` from `Stage` or `DeployRole`, checked when it resolves, so `pulumi preview` fails). Timeouts above 29 s are clamped |
| `Worker` | Workers script from a prebuilt module, R2 bucket `<product>-<env>-<kind>` (on prod, `adoptExisting` imports that same name instead of creating it), plain and secret bindings, custom domain | a secret-looking name in `vars` unless listed in `plainTextAllowed`; `adoptExisting` outside prod |
| `DeployRole` | the GitHub OIDC role for one product and env, its inline policy, and the boundary policy its roles must carry. `preview` allows the state bucket and the KMS key only. `staging` and `prod` also allow Lambda, API Gateway, ACM, logs and IAM inside `<product>-<env>`. Takes `product`, `env`, the repo and the apex (the zone name): the trusted GitHub environment, the account's OIDC provider, the state bucket and paths (`pebble-<stg\|prd>-pulumi-state/<product>/<env>`, plus `<product>/shared` for staging) and the KMS key (`alias/pebble-<stg\|prd>-pulumi-<env>`) are derived | a product id that is not one DNS label, a `pebble` product, or an apex that is not lowercase labels with no leading or trailing dot |

Every component refuses a hostname or name outside its stage (`NamespaceError`), and every refusal is a
`GuardrailError` subclass. On `prod` (and `shared`, which owns production's Vercel project) every child resource gets
`protect` and `retainOnDelete`; the Postgres provider, which is configuration rather than a cloud resource, does not.

## Names

| Stack | `stage.name('api')` | `stage.hostname('api', 'pebbletech.my')` | `stage.databaseName()` |
|---|---|---|---|
| `pr-7` | `base-pr-7-api` | `api-base-pr-7.pebbletech.my` | `base_pr_7` |
| `staging` | `base-staging-api` | `api-base-stg.pebbletech.my` | `base_stg` |
| `prod` | `base-prod-api` | `api-base.pebbletech.my` | `base_prd` |

Hostnames and database names keep base-app's `stg`/`prd` suffixes; resource names use the env.

A product id is one DNS label (`^[a-z][a-z0-9]{1,}$`, no hyphen), and a kind passed to `Stage.name` or `hostname` is one label too.

## Ownership

- `shared`: the Vercel project and its custom environments. Apply it before `staging` and `prod`. It has no deploy role
  of its own. The staging role applies it, so its state lives at `<product>/shared` in `pebble-stg-pulumi-state` and
  its secrets use the staging key (`stateKeyAlias('shared')` is `alias/pebble-stg-pulumi-staging`).
- `pr-<n>`: a database and its role. Previews pass env to `vercel deploy`.
- `staging`, `prod`: database, API, Worker, web env vars and domain.
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

## Test a program

`@pebbletech/infra/testing` runs a program against Pulumi's mocks and returns every registered resource with the
options the engine would see (`protect`, `retainOnDelete`, import id, parent). It rejects with the program's first
unhandled rejection, such as a guardrail thrown inside an `apply`, as `pulumi preview` would fail:

```ts
import { runProgram } from '@pebbletech/infra/testing';

const { resources } = await runProgram({ project: 'basefresh', stack: 'prod' }, () => program());
expect(resources.filter((r) => r.type === 'aws:lambda/function:Function' && !r.protect)).toEqual([]);
```

[`examples/basefresh`](https://github.com/pebble-tech/toolkit/tree/main/examples/basefresh) is a whole product program
with its tests.
