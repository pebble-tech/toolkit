# pebble-cluster-operators

Each Postgres cluster's `pebble_operators` group and the people in it: one Pulumi stack per cluster (`pebble-stg`,
`pebble-prd-shared`), built from `Operators` in `@pebbletech/infra` with `cluster` instead of a product's `Stage`.
Every product's `Database` grants its owner role to the group, so a member can connect to, change and drop every
toolkit-managed database on that cluster. Kong applies it by hand with SSO. Nothing in it belongs to a product, and
its admin, the cluster admin, is a role no product uses.

| Stack | Cluster | State | Secrets key |
|---|---|---|---|
| `pebble-stg` | `pebble-stg` (pbt-stg account) | `s3://pebble-stg-pulumi-state/cluster-operators` | `alias/pebble-stg-pulumi-staging` |
| `pebble-prd-shared` | `pebble-prd-shared` (pbt-prd account) | `s3://pebble-prd-pulumi-state/cluster-operators` | `alias/pebble-prd-pulumi-prod` |

- **State** lives in each account's state bucket, as the [account bootstrap](../bootstrap/README.md)'s does, under
  `cluster-operators/`: a product's deploy role may read only its own `<product>/<env>` paths, and the production
  cluster's state is in the prd account, out of reach of staging credentials.
- **Secrets** use the same key as the bootstrap's own stack in that account. The stack file holds one secret, the
  member list, as ciphertext; a product's deploy role in the same env could decrypt that ciphertext with the key, and
  a list of role names grants nothing. The cluster admin's URL is never stack config: the program reads it from
  `CLUSTER_ADMIN_URL`, so it is in no file. Pulumi keeps the provider's credentials in the state, encrypted, under the
  path no deploy role reads.
- **No `Stage`**: a cluster is not a product stage. `Stage` refuses the `pebble` prefix and any stack name but
  `pr-<n>`, `staging`, `prod` and `shared`, so `Operators` takes `cluster` (the stack name) instead and protects and
  keeps the group as on prod.
- **The check before every preview and apply**: the program reads the group's memberships first. A membership that
  gives access and that another role granted (on PostgreSQL 16+ only the granting role can revoke it) is refused when
  its role is not on the list, naming the role that can revoke it and the line to run; it is a warning when its role
  is on the list. The cluster admin's own membership must give no access (`INHERIT FALSE, SET FALSE`), or it is refused
  the same way.

Who holds what on `pebble_operators` after the handover, as `src/handover.postgres.test.ts` checks on a real Postgres:

| Role | On `pebble_operators` | Granted by |
|---|---|---|
| each member | membership (INHERIT, SET) | the cluster admin |
| the cluster admin | ADMIN OPTION only | the product admin that created the group (a fresh cluster: the cluster admin created it) |
| the product admin that created the group | ADMIN OPTION only, implicit | the bootstrap superuser; no admin can revoke it |
| every other product admin | nothing; ADMIN OPTION on its own owner roles, which `Database` grants to the group | |

## Before you start

- What the [account bootstrap's "Before you start"](../bootstrap/README.md#before-you-start) lists: the AWS SSO
  profiles, Pulumi CLI 3.271 or later, Node 24, and `corepack pnpm install --frozen-lockfile && corepack pnpm build`
  at the repository root (Pulumi runs `cluster-operators/dist/`).
- The `pscale` CLI, logged in to the `pebble-tech` org, plus `psql` and `jq`.
- The cluster admin's URL in the shell, from the password manager, for every command below that runs the program:

  ```sh
  export CLUSTER_ADMIN_URL='postgresql://<username>:<password>@<host>:5432/postgres?sslmode=verify-full'
  ```

## Create the cluster admin

Once per cluster. Run with `pebble-stg`, then `pebble-prd-shared`:

```sh
cluster=pebble-stg
admin="$(pscale role create "$cluster" main cluster-operators --org pebble-tech --format json)"
jq -r '"postgresql://\(.username):\(.password | @uri)@\(.access_host_url):5432/postgres?sslmode=verify-full"' <<<"$admin"
unset admin
```

Store the printed URL in the password manager as that cluster's cluster admin; it goes in no GitHub environment. No
`--inherited-roles`: on a cluster whose group exists, the program needs only the ADMIN OPTION the handover grants (the
test runs it with a role that has nothing but LOGIN). Only creating the group on a fresh cluster needs CREATEROLE: for
a new cluster, add `--inherited-roles postgres`, as the product admins have.

Check, with `psql "$CLUSTER_ADMIN_URL"`:

```sql
select current_user, rolcreaterole, rolcreatedb, rolsuper from pg_roles where rolname = current_user;
```

Expect the username without its `.<branch>` suffix, then `f`, `f`, `f`. These PlanetScale behaviours are assumptions
this repository could not test: that `pscale role create` without inherited roles gives a role with none of the three;
that the SQL role name is the username before the dot, as for every role so far; and that `pscale_admin` is not needed
for anything here. If any check differs, stop.

## Hand the group over

On a cluster where a product's stacks created `pebble_operators` (today: base-app's `shared` stack on `pebble-stg`,
its `prod` stack on `pebble-prd-shared`). Every member keeps access at every step; the order is what guarantees it.
Below, `PRODUCT_ADMIN_URL` is that product's admin URL on this cluster (its `PG_ADMIN_URL` there), and the cluster
admin's role is the username in `CLUSTER_ADMIN_URL` before the dot.

Run this query after each step; it lists every membership that gives access:

```sql
select pg_get_userbyid(member) as member, pg_get_userbyid(grantor) as grantor
from pg_auth_members
where roleid = 'pebble_operators'::regrole and (inherit_option or set_option)
order by 1, 2;
```

Before step 1 it shows each member granted by the product admin, and nothing else.

1. **The product admin lets the cluster admin administer the group, with no access through it:**

   ```sh
   psql "$PRODUCT_ADMIN_URL" -c 'GRANT pebble_operators TO "<cluster admin role>" WITH ADMIN OPTION, INHERIT FALSE, SET FALSE'
   ```

   Check: the query is unchanged, and `select admin_option, inherit_option, set_option from pg_auth_members where
   roleid = 'pebble_operators'::regrole and member = '<cluster admin role>'::regrole` shows `t`, `f`, `f`. This is
   the only grant the product admin makes.

2. **Create the cluster stack and adopt the group.** From `cluster-operators/`, in one shell, logged in to the
   account (`AWS_PROFILE=pbt-stg` for `pebble-stg`, `pbt-prd` for `pebble-prd-shared`):

   ```sh
   pulumi login 's3://pebble-stg-pulumi-state/cluster-operators?region=ap-southeast-1'
   pulumi stack init pebble-stg --secrets-provider 'awskms://alias/pebble-stg-pulumi-staging?region=ap-southeast-1'
   pulumi config set adoptExisting true
   pulumi config set --secret members '["<role>", "<role>"]'
   pulumi preview
   ```

   `members` is exactly the product's current list for this cluster. Expect one `import` (`operators-group`), creates
   for the stack, the `Operators` component, its provider and one `operators-member-<role>` per member, one warning
   per member that its membership is also granted by the product admin, and nothing else. A refusal naming a role
   means the cluster has a membership not on the list: add the role, or have its grantor revoke it, and preview again.

   ```sh
   pulumi up
   ```

   Check: the query shows each member twice, granted by the product admin and by the cluster admin.

3. **Remove `Operators` from the product's stack** (`shared` for `pebble-stg`, `prod` for `pebble-prd-shared`). The
   group is protected in that state, and a protected resource stops an apply only when its delete comes up, after the
   member grants' deletes have run. Unprotect it first, so the apply that removes `Operators` runs to the end and
   leaves nothing half-deleted. With the product's state credentials, right before the deploy of the change, with no
   other deploy of that stack in between (an older program would protect it again):

   ```sh
   pulumi state unprotect 'urn:pulumi:<stack>::<project>::pebbletech:index:Operators$postgresql:index/role:Role::operators-group'
   ```

   Then deploy the change that drops `Operators` from that stack. Its preview must show exactly: `delete` for each
   `operators-member-<role>`, `delete[retain]` for `operators-group`, `delete` for the `operators-admin` provider and
   the `operators` component, and nothing else. A `delete` without `[retain]` on the group: stop. Each member grant's
   delete runs `REVOKE` as the product admin, which removes only that admin's own row; the cluster admin's rows keep
   every member in, and the group itself stays (retained: dropped from the state only).

   Check: the query shows each member once, granted by the cluster admin; `select 1 from pg_roles where rolname =
   'pebble_operators'` still returns a row; a member can still connect to a product database.

4. **Stop adopting:**

   ```sh
   pulumi config set adoptExisting false
   pulumi preview
   ```

   Expect no changes and no warning. Commit the stack file: `git add Pulumi.pebble-stg.yaml`. Check before committing
   that `grep -A1 members Pulumi.pebble-stg.yaml` shows `secure: v1:…`, never a role name.

For `pebble-prd-shared`, the same four steps with `AWS_PROFILE=pbt-prd`, stack `pebble-prd-shared`,
`s3://pebble-prd-pulumi-state/cluster-operators?region=ap-southeast-1`,
`awskms://alias/pebble-prd-pulumi-prod?region=ap-southeast-1`, the product's production admin URL and its `prod`
stack. Step 3 there lands with the product's next release.

### What base-app changes (tec-346-base)

The product side of step 3, once per cluster, in base-app at its current main:

- `infra/src/app.ts`: drop `Operators` from the import, the `new Operators(...)` in the `shared` branch and the one
  before `Database` in `prod`, and `operators` from `BaseInputs`. `Database` is unchanged.
- `infra/src/config.ts`: drop the `operators` input and the import of `./operators.js`; `shared` no longer needs
  `pgAdminUrl`, so drop `shared` from that entry's stacks.
- `.github/workflows/deploy-staging.yml`: the `Pulumi up (shared)` step no longer passes `PG_ADMIN_URL`, and its two
  comments about pebble-stg's operators group go.
- `infra/operators.json`, `infra/src/operators.ts`, `infra/src/operators.test.ts`: delete. The lists move into the
  cluster stacks' `members`, as ciphertext.
- `infra/src/app.test.ts`: the `shared` and `prod` resource lists lose the `Operators` entries, and the test that the
  group is applied before the database grant goes; `db-operators` stays. `infra/src/config.test.ts`: the `shared`
  case no longer reads the admin URL.
- `docs/deployment.md` (stacks table, database roles, "Operators") and `docs/runbooks/phase-2-cutover.md`
  ("Operators"): the group is the cluster stack's; adding a person means `pulumi config set --secret members` in this
  program, applied by Kong.
- Order: step 3 for `pebble-stg` lands with the merge that deploys `shared`; for `pebble-prd-shared` with the release
  that applies `prod`. Both after this program's step 2 on that cluster, and each right after its unprotect.

## Add or remove an operator

1. The person creates a PlanetScale role for themselves on the cluster's `main` branch with no inherited roles, and
   sends its username without the `.<branch>` suffix (`pscale_api_xxxxxxxxxxxx`).
2. From `cluster-operators/`, logged in as in step 2 above, with `CLUSTER_ADMIN_URL` exported:

   ```sh
   pulumi config get members
   pulumi config set --secret members '[<the whole new list>]'
   pulumi preview   # one create per added role, one delete per removed role
   pulumi up
   git add Pulumi.pebble-stg.yaml   # or Pulumi.pebble-prd-shared.yaml; ciphertext only
   ```

A removal revokes the cluster admin's grant. If the preview is refused naming a role and its grantor, someone else
granted that membership too; the error prints the `REVOKE` its grantor must run.

## Later runs

```sh
cd cluster-operators
aws sso login --sso-session pbt
export AWS_PROFILE=pbt-stg   # or pbt-prd
pulumi login 's3://pebble-stg-pulumi-state/cluster-operators?region=ap-southeast-1'   # or pebble-prd-…
export CLUSTER_ADMIN_URL='…'   # this cluster's, from the password manager
pulumi up -s pebble-stg      # or pebble-prd-shared
```

Rebuild first (`corepack pnpm build` at the root) if the program changed.

## A fresh cluster

Create the cluster admin with `--inherited-roles postgres`, then step 2 without `adoptExisting`: the program creates
the group, and the cluster admin holds the creator's ADMIN OPTION. Apply it before any product stack on that cluster.

## Replace an admin

- **The cluster admin**: reset its password in PlanetScale and update the password manager; do not replace the role.
  A new role would need ADMIN OPTION from the old one and would have to grant every member again before the old one's
  rows could go.
- **The product admin that created the group**: keep the role; reset its password instead. Postgres refuses to drop
  it while the cluster admin's ADMIN OPTION rests on its grant. Never run `DROP OWNED BY` it, or `REVOKE ... CASCADE`
  from it: `DROP OWNED BY` takes the cluster admin's ADMIN OPTION and every database's grant to the group, leaving the
  members' rows with no admin able to revoke them; `REVOKE pebble_operators FROM <cluster admin> CASCADE` takes every
  membership the cluster admin granted. The test shows both.
