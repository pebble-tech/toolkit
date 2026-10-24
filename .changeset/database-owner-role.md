---
"@pebbletech/infra": minor
---

`Database` owns every database through a login role it creates, on every stage. On PlanetScale Postgres only `pscale_admin` can grant membership in a PlanetScale-made role, so the admin could not make such a role the owner and the first `pulumi up` on a fresh cluster failed at `CREATE DATABASE … OWNER`.

| Role | Made by | `pr-<n>` | `staging`, `prod` |
|---|---|---|---|
| owner: `<database>` on a preview, `<database>_owner` on staging and prod | the component, with a generated password; no CREATEDB, CREATEROLE or SUPERUSER | owns the database; `directUrl` | owns the database; `directUrl` (port 5432) for migrations and the seed |
| runtime: `runtime.role` | PlanetScale (`pscale`), passed in with its password | none: the owner is also the runtime | CONNECT; USAGE on `public`; SELECT, INSERT, UPDATE, DELETE on all tables; USAGE, SELECT, UPDATE on all sequences; the same on tables and sequences the owner creates later; owns nothing; `pooledUrl` (pooler, port 6432) |
| admin: the `adminUrl` user | you, with CREATEDB and CREATEROLE | member of the owner | member of the owner |
| operators: `pebble_operators` (`OPERATORS_GROUP`), NOLOGIN | the admin, once per cluster | member of the owner | member of the owner |

Breaking for callers: the argument `owner: { role, password }` is renamed `runtime` and the type `DatabaseOwner` is now `DatabaseRuntime`. `owner`, `ownerRole` and `ownerPassword` are refused with a message naming the rename; `runtime` is refused on a preview. On an existing staging or prod stack the next `pulumi up` creates `<database>_owner` and changes the database's owner to it, which needs the admin to be able to act as the current owner.

New: every database's owner role is granted to the cluster's `pebble_operators` group, whose members can connect to, change and drop every toolkit-managed database on that cluster. The admin creates the group once per cluster (`CREATE ROLE pebble_operators NOLOGIN`) before the first `pulumi up` there; see the README. Both memberships in the owner set `ignoreChanges: ['withAdminOption']`, so a consumer's transformation for the postgresql 3.18.2 refresh bug can go. `@pebbletech/infra/testing`'s `Registration` gains `ignoreChanges`.
