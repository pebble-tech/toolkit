import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { lintStaged } from './index.js';

// The presets are base-app's committed config minus what only base-app can mean. Each exclusion is named here;
// anything else that differs is drift. Runs against a base-app checkout named by BASE_APP_DIR.
const baseAppDir = process.env.BASE_APP_DIR;
const skipReason = 'BASE_APP_DIR is unset: the fidelity check needs a base-app checkout and runs locally';

const packageDir = join(import.meta.dirname, '..');
type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const preset = (file: string): Json => readJson(join(packageDir, file));
const baseApp = (file: string): Json => readJson(join(baseAppDir ?? '', file));

const without = (object: Json, ...keys: string[]): Json =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

// A product import group names the product's own scope (`@base/**`) or a `#` subpath alias.
const isProductPattern = (pattern: string): boolean => pattern.startsWith('#') || pattern.startsWith('@base/');

type CustomGroup = { groupName: string; elementNamePattern: string[] };
type Group = string | string[] | { newlinesBetween: boolean };

// Removes the product's import groups from oxfmt's sortImports. A `newlinesBetween` marker stays only when both of
// its neighbours stay, since it describes the gap between them.
function withoutProductImportGroups(sortImports: Json): Json {
  const customGroups = sortImports.customGroups as CustomGroup[];
  const productNames = new Set(
    customGroups.filter((group) => group.elementNamePattern.every(isProductPattern)).map((group) => group.groupName)
  );
  const groups = sortImports.groups as Group[];
  const kept = (group: Group | undefined): boolean =>
    Array.isArray(group) || (typeof group === 'string' && !productNames.has(group));
  const stripped = groups.flatMap((group, index): Group[] => {
    if (Array.isArray(group)) return [group.filter((name) => !productNames.has(name))];
    if (typeof group === 'string') return productNames.has(group) ? [] : [group];
    return kept(groups[index - 1]) && kept(groups[index + 1]) ? [group] : [];
  });
  return {
    ...sortImports,
    customGroups: customGroups.filter((group) => !productNames.has(group.groupName)),
    groups: stripped,
  };
}

describe('presets match base-app', () => {
  test('tsconfig.base.json equals base-app tsconfig.base.json minus paths and references', (ctx) => {
    ctx.skip(!baseAppDir, skipReason);
    const expected = baseApp('tsconfig.base.json');
    expect(preset('tsconfig.base.json')).toEqual({
      ...without(expected, 'references'),
      compilerOptions: without(expected.compilerOptions as Json, 'paths'),
    });
  });

  test('oxlint.json equals base-app .oxlintrc.json minus the apps/web overrides', (ctx) => {
    ctx.skip(!baseAppDir, skipReason);
    const expected = baseApp('.oxlintrc.json');
    const sharedOverrides = ((expected.overrides ?? []) as { files: string[] }[]).filter(
      (override) => !override.files.every((file) => file.startsWith('apps/web/'))
    );
    expect(preset('oxlint.json')).toEqual(
      sharedOverrides.length > 0 ? { ...expected, overrides: sharedOverrides } : without(expected, 'overrides')
    );
  });

  test('oxfmt.json equals base-app .oxfmtrc.json minus $schema, the tailwind stylesheet and product import groups', (ctx) => {
    ctx.skip(!baseAppDir, skipReason);
    const expected = baseApp('.oxfmtrc.json');
    expect(preset('oxfmt.json')).toEqual({
      ...without(expected, '$schema', 'sortTailwindcss'),
      sortImports: withoutProductImportGroups(expected.sortImports as Json),
    });
  });

  test('lintStaged equals the lint-staged map in base-app package.json', (ctx) => {
    ctx.skip(!baseAppDir, skipReason);
    expect(lintStaged).toEqual(baseApp('package.json')['lint-staged']);
  });
});
