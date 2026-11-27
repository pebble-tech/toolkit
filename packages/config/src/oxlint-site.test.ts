import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

// Lints a site repo laid out the way the README describes (the package installed under node_modules, the
// README's oxlint.config.ts at the root) with the pinned oxlint CLI, and reads which files break which rule.
const packageDir = join(import.meta.dirname, '..');
const oxlintBin = join(dirname(createRequire(import.meta.url).resolve('oxlint/package.json')), 'bin', 'oxlint');

const consumerConfig = `import base from '@pebbletech/config/oxlint.json' with { type: 'json' };
import site from '@pebbletech/config/oxlint-site.json' with { type: 'json' };

export default { ...site, extends: [base] };
`;

const confinedImports = `import Link from 'next/link';
import { getPayload } from 'payload';
import { postgresAdapter } from '@payloadcms/db-postgres';
import { useTheme } from 'next-themes';

export const used = [Link, getPayload, postgresAdapter, useTheme];
`;

const looseEquality = 'export const same = (a, b) => a == b;\n';

// Each of these would be reported if it were linted: the base preset's eqeqeq applies everywhere.
const ignored = [
  'apps/marketing/src/routeTree.gen.ts',
  'packages/x/src/payload-types.ts',
  'apps/cms/src/app/(payload)/admin/importMap.js',
  'apps/cms/.next/server/page.js',
  'apps/marketing/.output/server/index.mjs',
  'apps/marketing/.vercel/output/functions/index.js',
  'packages/x/dist/index.js',
  'packages/x/node_modules/dep/index.js',
];

const fixtures: Record<string, string> = {
  'apps/marketing/src/page.tsx': confinedImports,
  'packages/x/src/index.ts': confinedImports,
  'apps/cms/src/payload.config.ts': confinedImports,
  'apps/cms/src/loose.ts': looseEquality,
  ...Object.fromEntries(ignored.map((file) => [file, confinedImports + looseEquality])),
};

type Diagnostic = { code: string; filename: string; message: string };
let diagnostics: Diagnostic[] = [];

const findings = (file: string): string[] =>
  diagnostics
    .filter((diagnostic) => diagnostic.filename === file)
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .sort();

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'pebbletech-config-oxlint-site-'));
  mkdirSync(join(root, 'node_modules', '@pebbletech'), { recursive: true });
  symlinkSync(packageDir, join(root, 'node_modules', '@pebbletech', 'config'), 'dir');
  writeFileSync(join(root, 'oxlint.config.ts'), consumerConfig);
  for (const [file, source] of Object.entries(fixtures)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  // Without the ignore list oxlint walks the linked package's own node_modules, so the report can be large.
  const run = spawnSync(process.execPath, [oxlintBin, '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  diagnostics = (JSON.parse(run.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
});

describe('oxlint-site.json through the oxlint CLI', () => {
  const confined = [
    "eslint(no-restricted-imports): '@payloadcms/db-postgres' import is restricted from being used by a pattern.",
    "eslint(no-restricted-imports): 'next/link' import is restricted from being used by a pattern.",
    "eslint(no-restricted-imports): 'payload' import is restricted from being used by a pattern.",
  ];

  test.each(['apps/marketing/src/page.tsx', 'packages/x/src/index.ts'])(
    'next, payload and @payloadcms imports are errors in %s',
    (file) => {
      expect(findings(file)).toEqual(confined);
    }
  );

  test('apps/cms may import next and payload', () => {
    expect(findings('apps/cms/src/payload.config.ts')).toEqual([]);
  });

  test('the base preset still applies, in apps/cms too', () => {
    expect(findings('apps/cms/src/loose.ts')).toEqual(['eslint(eqeqeq): Expected === and instead saw ==']);
  });

  test.each(ignored)('%s is ignored', (file) => {
    expect(findings(file)).toEqual([]);
  });

  test('the run reports no other file', () => {
    expect([...new Set(diagnostics.map((diagnostic) => diagnostic.filename))].sort()).toEqual([
      'apps/cms/src/loose.ts',
      'apps/marketing/src/page.tsx',
      'packages/x/src/index.ts',
    ]);
  });
});
