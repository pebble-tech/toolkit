# AGENTS.md

pnpm workspace of packages published to npm under `@pebbletech`. Each package lives in `packages/<name>` and ships
compiled ESM (`dist/`) plus any files its `files` list names. See `README.md` for consuming and releasing.

## Setup

- Node 24 (`.node-version`, `engines >=24`; published packages declare `>=22.14`) and the pnpm in `packageManager`:
  `corepack enable` or `corepack pnpm`.
- pnpm 12 refuses unapproved build scripts: `allowBuilds` in `pnpm-workspace.yaml` is the list.
- Shared version pins go in the `catalog` in `pnpm-workspace.yaml`; everything else is pinned exactly.

## Checks

`pnpm verify` runs lint, format check, typecheck, build and tests, the same chain CI runs
(`.github/workflows/verify.yml`, which also packs every package and lists each tarball). Run it before every PR.

## Tests

- Vitest, one project per package (`packages/*/vitest.config.ts`), tests next to the code as `src/**/*.test.ts`.
  `pnpm test -- <path>` narrows the run.
- Pure logic gets a unit test that calls it the way a consumer does.
- Never mock owned code. Fake an external service at its boundary.
- A test you add or change must fail on the code before your change and pass after it. There is no CI gate for this
  yet: run it by hand and say so in the PR.
- oxlint runs the vitest rules: every test asserts, no conditional or standalone `expect`, no `.skip` / `.only`.
- `@pebbletech/config`'s fidelity test compares the presets with base-app's committed config. It runs only with
  `BASE_APP_DIR` pointing at a base-app checkout; run it when you change a preset or base-app changes its config.

## Packages

- A published package ships `dist/` from `tsc`, ESM only, with `exports`, a `files` whitelist, `sideEffects: false`,
  `publishConfig.access: public` and `license: MIT`. Tests stay out of the tarball; the pack listing in CI shows it.
- A change to a package's published behaviour comes with a changeset (`pnpm changeset`).
- Never run `pnpm publish`, `changeset publish` or `pnpm release` by hand; the release workflow publishes.

## Naming

Product resources are named `<product>-<env>`, with env one of `pr-N`, `staging`, `prod`. The `pebble-*` prefix is
for internal or shared resources only (`pebble-stg`, `pebble-prd-shared`); a product never uses it.

## Git and PRs

- Branch from `main`: `{feat|fix|chore}/<short-kebab-slug>`.
- Conventional Commits (`feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`, `build`).
- PR title `[TEC-N] Short summary`, with the Linear key from team Techies.
- No tool or agent attribution in commits or PRs.
