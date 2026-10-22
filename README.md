# Pebble toolkit

Shared packages for Pebble product repos, published to npm under `@pebbletech`. A product pins a version instead of
copying config and infrastructure code from base-app.

| Package | What it carries |
|---|---|
| [`@pebbletech/config`](packages/config) | base-app's tsconfig base, oxlint and oxfmt presets, and the lint-staged map |

## Use `@pebbletech/config`

```sh
pnpm add -D @pebbletech/config
echo '{ "extends": "@pebbletech/config/tsconfig.base.json" }' > tsconfig.base.json
echo '{ "extends": ["./node_modules/@pebbletech/config/oxlint.json"] }' > .oxlintrc.json
```

oxfmt has no `extends`: spread `@pebbletech/config/oxfmt.json` in `oxfmt.config.ts` and add the product's import
groups. [packages/config/README.md](packages/config/README.md) has the example and the lint-staged setup.

## Develop

Node 24 and the pnpm pinned in `packageManager` (`corepack enable`, or `corepack pnpm`).

```sh
pnpm install
pnpm verify          # lint, format check, typecheck, build, tests
BASE_APP_DIR=../base-app-monorepo pnpm test   # also checks the presets still match base-app
```

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

Authentication: the first publish of each package uses the `NPM_TOKEN` repository secret (a granular npm token with
publish rights on `@pebbletech`), passed as `NODE_AUTH_TOKEN`. After that first publish, switch the package to trusted
publishing: on npmjs.com, package settings, add a trusted publisher for GitHub Actions with organisation
`pebble-tech`, repository `toolkit` and workflow `release.yml`. Once every published package has one, delete the
`env` block from the publish step and the `NPM_TOKEN` secret. The workflow already grants `id-token: write`, which is
what npm checks; packages published that way get provenance, token publishes do not.

## License

MIT
