---
'@pebbletech/infra': minor
---

`Database` takes `schemas` and `flavor`, and `DeployRole` takes `awsResources`, for client sites on a Neon database. A
program that passes none of them declares the same resources, names and inputs as on 0.7.0.

- `Database` `schemas` (default `['public']`): each schema other than `public` is created, owned by the owner role, and
  the runtime role gets the same rights on it as on `public`, in resources named `<name>-schema-<schema>`,
  `<name>-runtime-{schema,tables,sequences}-<schema>` and `<name>-runtime-default-{tables,sequences}-<schema>`.
  `public`'s resources keep their names. A list without `public` grants nothing on it. An empty or repeated list, or a
  name that is not a lowercase identifier or is `pg_*` or `information_schema`, is refused.
- `Database` `flavor: 'neon'` (default `'planetscale'`): usernames are used as given, no owner role is granted to
  `pebble_operators`, and `pooledUrl` is on the admin host with `-pooler` added to its first label, port 5432. An admin
  URL on a `-pooler` host is refused. One Neon branch is one stack; the toolkit calls no Neon API.
- `DeployRole` `awsResources: false` gives a `staging` or `prod` role only the state statements a preview role has. The
  role, trust and boundary do not change. A preview ignores it.
