/**
 * The lint-staged map every Pebble product repo runs on pre-commit, as base-app has it:
 * oxfmt formats code files, oxlint lints them. Markdown, JSON and YAML stay unformatted on purpose.
 */
export const lintStaged = {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': ['oxfmt'],
  '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}': 'oxlint',
} as const satisfies Record<string, string | readonly string[]>;

/** The preset files this package ships, by tool, as package subpaths a consumer references. */
export const presets = {
  tsconfig: '@pebbletech/config/tsconfig.base.json',
  oxlint: '@pebbletech/config/oxlint.json',
  oxfmt: '@pebbletech/config/oxfmt.json',
} as const;
