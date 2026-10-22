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
