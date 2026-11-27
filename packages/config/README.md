# @pebbletech/config

The TypeScript, oxlint, oxfmt and lint-staged presets every Pebble product repo shares, taken from base-app.

```sh
pnpm add -D @pebbletech/config oxlint oxfmt typescript lint-staged
```

| Tool | Preset | How a product uses it |
|---|---|---|
| TypeScript | `@pebbletech/config/tsconfig.base.json` | `"extends": "@pebbletech/config/tsconfig.base.json"` in `tsconfig.base.json` |
| oxlint | `@pebbletech/config/oxlint.json` | `"extends": ["./node_modules/@pebbletech/config/oxlint.json"]` in `.oxlintrc.json` (oxlint resolves `extends` as a path) |
| oxfmt | `@pebbletech/config/oxfmt.json` | spread it in `oxfmt.config.ts` (oxfmt has no `extends`) |
| lint-staged | `lintStaged` export | `export { lintStaged as default } from '@pebbletech/config';` in `lint-staged.config.mjs` |

## Import groups are the product's

The oxfmt preset sorts imports as side effects, React, externals, then relative paths. A product adds its own scope and
`#` aliases as groups before the relative ones:

```ts
// oxfmt.config.ts
import preset from '@pebbletech/config/oxfmt.json' with { type: 'json' };

const { customGroups, groups } = preset.sortImports;
const relative = groups.findIndex((group) => Array.isArray(group) && group.includes('parent'));

export default {
  ...preset,
  sortImports: {
    ...preset.sortImports,
    customGroups: [...customGroups, { groupName: 'app', elementNamePattern: ['@app/**', '#app/**'] }],
    groups: [...groups.slice(0, relative), 'app', ...groups.slice(relative)],
  },
};
```

A product using Tailwind adds `sortTailwindcss: { stylesheet: './path/to/app.css' }` the same way.

Product-specific settings stay in the product: `paths` and `references` in tsconfig, file-scoped oxlint `overrides`,
and the import groups above.

## Renovate

The Renovate preset is [`renovate.json`](./renovate.json) in this directory. Renovate reads it from the toolkit repo
on GitHub, not from npm, so it is not in the package. A repo's `renovate.json` names it as its only `extends` entry:

```json
"extends": ["github>pebble-tech/toolkit//packages/config/renovate"]
```

Renovate fetches it from the toolkit's default branch on every run, so a change merged here reaches every repo on its
next run. To hold a repo on one version, add a commit SHA (`…//packages/config/renovate#<sha>`). A release tag does not
work here: Renovate accepts only letters, digits, `_`, `-`, `.` and `/` after the `#`, and the toolkit's tags contain `@`.

What the preset sets:

- `config:recommended`, semantic commits, at most ten open PRs, the `dependencies` label, `pnpm dedupe` after updates.
- Weekly: before 6am on Monday, Kuala Lumpur time, and only for releases at least three days old.
- Security fixes at any time, with no release age, labelled `dependencies` and `security`. They come from the repo's
  Dependabot alerts, so the repo needs Dependabot alerts turned on and the Renovate app allowed to read them. The
  preset leaves `osvVulnerabilityAlerts` off, so without those alerts there are no security PRs.
- Minor and patch updates in one `minor and patch` PR. Each major is its own PR.
- `payload` with `@payloadcms/*`, and `next` with `@next/*` and `eslint-config-next` (npm only), each as one group,
  majors included: the packages in each family share one version. Patches get their own branch and PR
  (`renovate/patch-payload`, `renovate/patch-next`), apart from minors (`renovate/payload`, `renovate/next`).
- `@pebbletech/infra` and the toolkit's pins in one group, with no release age. A pin is a composite action
  (`uses: pebble-tech/toolkit/.github/actions/<name>@<sha> # @pebbletech/infra@<version>`) or a reusable workflow
  (`uses: pebble-tech/toolkit/.github/workflows/<name>.yml@<sha> # @pebbletech/infra@<version>`), in a file in
  `.github/workflows/`. A `toolkit-ref:` input right below the pin, as in the site-deploy stub, moves to the same SHA.
  The regex manager reads the pins, and the GitHub Actions manager leaves them alone
  ([`@pebbletech/infra`, Renovate](../infra/README.md#renovate)).
- Node and pnpm pins (`node`, `pnpm`, `@types/node`) are never updated by the bot.

### A repo's own groups

A repo adds its own groups (TanStack, Vite, Pulumi and so on) as `packageRules` after the `extends` line. Renovate
puts a preset's rules before the repo's own, and when several rules match, the last one wins. So a repo's group takes
its packages out of `minor and patch` without listing them as exclusions. For the same reason, a repo's group also
collects its packages' majors into one PR, unless the rule says `"matchUpdateTypes": ["!major"]`:

```json
{ "matchPackageNames": ["/^@pulumi\\//"], "matchUpdateTypes": ["!major"], "groupName": "pulumi" }
```

A repo that moves to the preset from a config with exclusion lists should check two things. Every group it keeps needs
`"matchUpdateTypes": ["!major"]` if its majors should stay one PR each. And a group that its old catch-all did not
exclude (base-app's tooling group: oxlint, prettier, tsx and the rest) now also takes those packages' minors and
patches, which the old catch-all used to take.

### Auto-merge

Only Payload and Next.js updates from npm auto-merge, and only two kinds:

- patch updates, unless Renovate marks the update breaking (a prerelease step such as a canary, or a patch of a 0.x
  version);
- security fixes that are a patch or a minor update. A security fix that needs a major waits for a person.

Their other minors and majors, and every other package's updates, wait for a person. A grouped PR auto-merges only
when every update in it does.

Renovate never takes auto-merge off a PR once it has turned it on, even when it later pushes different updates to the
same branch. That is why patches have their own branch: a branch that is set to auto-merge only ever holds patches,
and a minor goes to a different branch and PR.

The preset uses GitHub's own auto-merge (`automergeType: "pr"`, `platformAutomerge: true`): Renovate turns it on when it
opens the PR, and GitHub merges once the branch's rules are met. That makes the repo's settings the safeguard. The
preset changes none of them, so set them yourself:

- A branch protection rule or ruleset on the default branch that requires the CI checks (`verify`, and anything
  else that must pass). Without required checks, GitHub refuses to turn auto-merge on, and Renovate merges the PR
  itself on a later run once every check on the branch has passed.
- "Allow auto-merge" turned on. With it off, Renovate merges the PR itself in the same way.
- No required approving review for Renovate's PRs, or those PRs wait for one.
- No bypass for the Renovate app in the ruleset. An actor allowed to bypass the ruleset merges without the required
  checks.

GitHub counts a required check that was skipped (a job whose `if:` was false) as passed. A check that must gate the
merge has to run on Renovate's PRs.
