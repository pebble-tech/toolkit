# Pebble toolkit

Shared packages for Pebble product repos, published to npm under `@pebbletech`. A product pins a version instead of
copying config and infrastructure code from base-app.

| Package | What it carries |
|---|---|
| [`@pebbletech/config`](packages/config) | base-app's tsconfig base, oxlint and oxfmt presets, and the lint-staged map |
| [`@pebbletech/infra`](packages/infra) | Pulumi components for a product's `infra/` program (`Stage`, `VercelProject`, `Database`, `ApiFunction`, `Worker`, `DeployRole`, `Operators`), the `pebble-infra` CLI its workflows run, and `@pebbletech/infra/testing` |

## Use `@pebbletech/config`

```sh
pnpm add -D @pebbletech/config
echo '{ "extends": "@pebbletech/config/tsconfig.base.json" }' > tsconfig.base.json
echo '{ "extends": ["./node_modules/@pebbletech/config/oxlint.json"] }' > .oxlintrc.json
```

oxfmt has no `extends`: spread `@pebbletech/config/oxfmt.json` in `oxfmt.config.ts` and add the product's import
groups. [packages/config/README.md](packages/config/README.md) has the example and the lint-staged setup.

## Use `@pebbletech/infra`

```sh
pnpm --dir infra add --save-exact @pebbletech/infra@next @pulumi/pulumi
```

`@next` is the 0.4.0-next.N prerelease ([Prereleases](#prereleases)); `latest` is still 0.3.2, without `pebble-infra`.

A product's `infra/` program builds every stage from one `Stage` (`pr-<n>`, `staging`, `prod`, plus `shared` for the
Vercel project). Names stay inside `<product>-<env>`, roles carry a permissions boundary, APIs need a custom domain,
and prod resources are protected and retained (the Worker and Vercel domains are protected only, so a replacement
frees the hostname); the components refuse anything else. Compile the program with `tsc` and run Pulumi with
`typescript: false`, since Pulumi's TypeScript peer is `<7`; install with pnpm, because npm
refuses that optional peer next to TypeScript 7 without an `overrides` entry or `--legacy-peer-deps`. `shared` and
`prod` are protected, so their teardown starts with `pulumi state unprotect --all`. A `preview` deploy role can use
only its state path and KMS key. A staging or prod deploy role can create a custom domain of any name (`POST` on `/domainnames` has no name condition), can edit routes, integrations and stages under another HTTP API's id, and can change a hostname in a sub-zone of its apex whose label ends with `-<product>-stg` or `-<product>` (for example `api-x-stg.foo-basefresh-stg.pebbletech.my`); API Gateway tag updates after creation are denied, and creation-time tags still arrive through `CreateApi`.
[packages/infra/README.md](packages/infra/README.md) has the components, the naming table and, under "Use it", how a
product composes 0.4: the program, its entries module, `pebble-infra`, the `setup` and `pulumi` actions in
[.github/actions](.github/actions), the workflow checks and the Renovate group. [examples/web-only](examples/web-only)
is a web-only product's program and production workflow; [examples/basefresh](examples/basefresh) is a whole product
program with its three workflows, all tested.

Two Pulumi programs here belong to no product and are applied by hand: [bootstrap/](bootstrap/README.md), each AWS
account's shared bootstrap (GitHub OIDC provider, state bucket, state KMS keys, alarm topic), once per account; and
[cluster-operators/](cluster-operators/README.md), each Postgres cluster's `pebble_operators` group and its members,
once per cluster.

## Develop

Node 24 and the pnpm pinned in `packageManager` (`corepack enable`, or `corepack pnpm`).

```sh
pnpm install
pnpm verify          # lint, format check, typecheck, build, tests
BASE_APP_DIR=../base-app-monorepo pnpm test   # also checks the presets still match base-app
```

The Postgres tests (`stack.postgres.test.ts`, `cli.test.ts`, `handover.postgres.test.ts`) run against
`DATABASE_URL`, a local Postgres the tests may create and drop roles and databases in; without it they skip, except
under `CI=true`, where they fail. CI gives them a Postgres service.

## Release

Changesets drives versions; `.github/workflows/release.yml` publishes.

1. A PR that changes a package adds a changeset: `pnpm changeset`, pick the package and the bump, write one line for
   the changelog.
2. On merge to `main`, the release workflow opens or updates a "chore: version packages" PR that applies the pending
   changesets (versions and `CHANGELOG.md`).
3. Merging that PR runs the workflow again with nothing pending; it runs `pnpm release` (`changeset publish`), which
   runs `pnpm publish --access public` for every package whose version is not on npm yet (`prepack` builds `dist/`
   first) and creates a `<name>@<version>` git tag for each. The action pushes the tags and opens a GitHub release per
   package.

Authentication: npm trusted publishing, with no token. Every published package has a trusted publisher on npmjs.com
for GitHub Actions (organisation `pebble-tech`, repository `toolkit`, workflow `release.yml`), and the workflow's
`id-token: write` is what npm checks; each publish gets provenance. A new package's first publish needs a trusted
publisher set up on npm first.

### Prereleases

While `.changeset/pre.json` exists the repository is in changesets pre mode, with the tag `next`: the version PR
versions a package as `<version>-next.<n>` (each later merge with a changeset raises `n`), and `changeset publish`
publishes it to npm's `next` dist-tag, so `latest` and every product that did not opt in stay where they are.

`@pebbletech/infra` 0.4 is in pre mode until base-app's recomposition on the prerelease is green. Then, on a branch,
run `pnpm changeset pre exit` and, in the same commit as the changed `.changeset/pre.json`, take the `next` tag back out
of every install line a product copies (`package.test.ts` fails until each one is changed):

- this README, "Use `@pebbletech/infra`": `@pebbletech/infra@next` in the command, and the line under it;
- `packages/infra/README.md` "Use it" step 1: the command and the sentence about the `next` tag;
- `packages/infra/README.md` "Upgrade to 0.4" step 1: the command and "until 0.4.0 is out".

Merge it: the next version PR versions `0.4.0` and deletes the pre-mode files, and merging it publishes `0.4.0` to
`latest`. Products then move from the `next` version to `0.4.0`, and their action
pins to the commit tagged `@pebbletech/infra@0.4.0`.

## License

MIT
