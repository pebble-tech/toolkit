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

## Site repos: `oxlint-site.json`

`@pebbletech/config/oxlint-site.json` is the oxlint preset plus two things a site repo (a Payload CMS app and the
apps that read its content) needs:

- It ignores generated files and build output: `node_modules`, `routeTree.gen.ts`, `payload-types.ts`, `importMap.js`,
  `.next`, `.output`, `.vercel` and `dist`.
- It makes imports of `next`, `payload` and `@payloadcms/*`, and of any path under them (`next/dist/client/link`,
  `@payloadcms/richtext-lexical/react`), errors everywhere except `apps/cms`. A new app or package is covered without a
  config change. Packages that only share the prefix, such as `next-themes`, `next-auth` and `payload-types`, are allowed.

oxlint applies `ignorePatterns` only from the root config, not from a config it `extends`. So a site takes this preset
through `oxlint.config.ts`, not through `extends` in `.oxlintrc.json`:

```ts
// oxlint.config.ts
import base from '@pebbletech/config/oxlint.json' with { type: 'json' };
import site from '@pebbletech/config/oxlint-site.json' with { type: 'json' };

export default { ...site, extends: [base] };
```

oxlint marks TypeScript config files as experimental and loads them only when it runs under Node.js, which the npm
package does.

A plain `.oxlintrc.json` with `"extends": ["./node_modules/@pebbletech/config/oxlint-site.json"]` gets the rules but not
the ignores. oxlint resolves `extends` as a path, so `"@pebbletech/config/oxlint-site.json"` there does not resolve.

What the import rule does not do:

- It does not exempt `import type`: a type-only import from `payload` outside `apps/cms` is an error too. Allow it
  file by file with an override that turns `no-restricted-imports` off for those files.
- It does not cover `require()`.
- A product override that sets `no-restricted-imports` for some files replaces this rule's patterns there; it does not
  add to them. Repeat the patterns in that override to keep them.

## Vite helpers: `@pebbletech/config/vite`

Option builders for a product's `vite.config.ts`, taken from base-app's `apps/web/vite.config.ts`. Each returns a plain
object for the product's own plugin, so this package needs none of vite, Nitro, TanStack or Sentry.

| Helper | Returns |
|---|---|
| `devServerPort(env?)` | `PORT` as a number, or 3000 |
| `sentryOptions({ project, org? }, env?)` | `undefined` without `SENTRY_AUTH_TOKEN`; otherwise the Sentry plugin options: org from `SENTRY_ORG`, else `org` (default `pebble-tech-sdn-bhd`), release from `SENTRY_RELEASE`, telemetry off |
| `nitroSkewProtection(deploymentId)` | Nitro's `manifest` and `vercel` options for Vercel Skew Protection. With no id (`undefined` or empty), `skewProtection` is `false`, so Vercel's own `VERCEL_*` variables cannot turn on the cookie route |

`env` defaults to `process.env`.

```ts
// vite.config.ts
import { devServerPort, nitroSkewProtection, sentryOptions } from '@pebbletech/config/vite';
import { sentryTanstackStart } from '@sentry/tanstackstart-react/vite';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

// CI sets one id per deploy; see @pebbletech/infra's README on Skew Protection.
const sentry = sentryOptions({ project: 'site-web' });

export default defineConfig({
  server: { port: devServerPort() },
  plugins: [
    // ...the framework plugins
    nitro(nitroSkewProtection(process.env.SITE_DEPLOYMENT_ID)),
    ...(sentry ? [sentryTanstackStart(sentry)] : []),
  ],
});
```
