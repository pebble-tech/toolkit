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
- Security fixes at any time, with no release age, labelled `dependencies` and `security`.
- Minor and patch updates in one `minor and patch` PR. Each major is its own PR.
- `payload` with `@payloadcms/*`, and `next` with `@next/*` and `eslint-config-next`, each as one group, majors
  included: the packages in each family share one version.
- `@pebbletech/infra` and the toolkit's action pins (`uses: pebble-tech/toolkit/.github/actions/<name>@<sha> #
  @pebbletech/infra@<version>`) in one group, with no release age. The regex manager reads the pins, and the GitHub
  Actions manager leaves them alone ([`@pebbletech/infra`, Renovate](../infra/README.md#renovate)).
- Node and pnpm pins (`node`, `pnpm`, `@types/node`) are never updated by the bot.

### A repo's own groups

A repo adds its own groups (TanStack, Vite, Pulumi and so on) as `packageRules` after the `extends` line. Renovate
puts a preset's rules before the repo's own, and when several rules match, the last one wins. So a repo's group takes
its packages out of `minor and patch` without listing them as exclusions. For the same reason, a repo's group also
collects its packages' majors into one PR, unless the rule says `"matchUpdateTypes": ["!major"]`:

```json
{ "matchPackageNames": ["/^@pulumi\\//"], "matchUpdateTypes": ["!major"], "groupName": "pulumi" }
```

### Auto-merge

Only Payload and Next.js updates auto-merge, and only two kinds: patch updates, and security fixes of any update type.
Their minors and majors, and every other package's updates, wait for a person. A grouped PR auto-merges only when
every update in it does, so a Payload PR that holds one minor waits as well.

The preset uses GitHub's own auto-merge (`automergeType: "pr"`, `platformAutomerge: true`): Renovate turns it on when it
opens the PR, and GitHub merges once the branch's rules are met. That makes the repo's settings the safeguard. The
preset changes none of them, so set them yourself:

- A branch protection rule or ruleset on the default branch that requires the CI checks (`verify`, and anything
  else that must pass). Without required checks there is nothing for GitHub to wait for.
- "Allow auto-merge" turned on. With it off, Renovate merges the PR itself on a later run, once every check on the
  branch has passed.
- No required approving review for Renovate's PRs, or those PRs wait for one.
