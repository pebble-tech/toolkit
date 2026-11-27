import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

// Lints a site repo laid out the way the README describes (the package installed under node_modules, a config at
// the root) with the pinned oxlint CLI, and reads which files break which rule.
const packageDir = join(import.meta.dirname, '..');
const oxlintBin = join(dirname(createRequire(import.meta.url).resolve('oxlint/package.json')), 'bin', 'oxlint');

// The README's config: oxlint reads ignorePatterns only from the root config, so the site spreads the preset.
const consumerConfig = {
  'oxlint.config.ts': `import base from '@pebbletech/config/oxlint.json' with { type: 'json' };
import site from '@pebbletech/config/oxlint-site.json' with { type: 'json' };

export default { ...site, extends: [base] };
`,
};

// A plain extends: the rules arrive, through the preset's own extends of oxlint.json too, but its ignores do not.
const extendsConfig = {
  '.oxlintrc.json': JSON.stringify({ extends: ['./node_modules/@pebbletech/config/oxlint-site.json'] }),
};

const confinedImports = `import 'next';
import Link from 'next/link';
import NextLink from 'next/dist/client/link';
import { getPayload } from 'payload';
import { sanitizeConfig } from 'payload/shared';
import { postgresAdapter } from '@payloadcms/db-postgres';
import { RichText } from '@payloadcms/richtext-lexical/react';
import { RootPage } from '@payloadcms/next/views';
import { useTheme } from 'next-themes';
import NextAuth from 'next-auth';
import { Post } from 'payload-types';
import payloadcms from 'payloadcms';
import nextjs from 'nextjs';

export const used = [
  Link,
  NextLink,
  getPayload,
  sanitizeConfig,
  postgresAdapter,
  RichText,
  RootPage,
  useTheme,
  NextAuth,
  Post,
  payloadcms,
  nextjs,
];
`;

const confined = [
  '@payloadcms/db-postgres',
  '@payloadcms/next/views',
  '@payloadcms/richtext-lexical/react',
  'next',
  'next/dist/client/link',
  'next/link',
  'payload',
  'payload/shared',
].map((source) => `eslint(no-restricted-imports): '${source}' import is restricted from being used by a pattern.`);

const looseEquality = 'export const same = (a, b) => a == b;\n';
const eqeqeq = 'eslint(eqeqeq): Expected === and instead saw ==';

// Outside apps/cms, including directories whose names only start with or end in cms.
const outsideCms = [
  'apps/marketing/src/page.tsx',
  'packages/x/src/index.ts',
  'packages/cms/src/index.ts',
  'apps/cms-admin/src/index.ts',
];

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
  ...Object.fromEntries(outsideCms.map((file) => [file, confinedImports])),
  'apps/cms/src/payload.config.ts': confinedImports,
  'apps/cms/src/loose.ts': looseEquality,
  ...Object.fromEntries(ignored.map((file) => [file, confinedImports + looseEquality])),
};

type Diagnostic = { code: string; filename: string; message: string };
type Findings = (file: string) => string[];

function lintSiteRepo(config: Record<string, string>): { findings: Findings; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'pebbletech-config-oxlint-site-'));
  mkdirSync(join(root, 'node_modules', '@pebbletech'), { recursive: true });
  symlinkSync(packageDir, join(root, 'node_modules', '@pebbletech', 'config'), 'dir');
  for (const [file, source] of Object.entries({ ...config, ...fixtures })) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  // apps and packages only, so a run without the ignores does not walk the linked package itself.
  const run = spawnSync(process.execPath, [oxlintBin, '--format', 'json', 'apps', 'packages'], {
    cwd: root,
    encoding: 'utf8',
  });
  const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
  return {
    findings: (file) =>
      diagnostics
        .filter((diagnostic) => diagnostic.filename === file)
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .sort(),
    files: [...new Set(diagnostics.map((diagnostic) => diagnostic.filename))].sort(),
  };
}

describe('oxlint-site.json through oxlint.config.ts', () => {
  let lint: ReturnType<typeof lintSiteRepo>;
  beforeAll(() => {
    lint = lintSiteRepo(consumerConfig);
  });

  test.each(outsideCms)('next, payload and @payloadcms imports, deep ones too, are errors in %s', (file) => {
    expect(lint.findings(file)).toEqual(confined);
  });

  test('apps/cms may import next and payload', () => {
    expect(lint.findings('apps/cms/src/payload.config.ts')).toEqual([]);
  });

  test('the base preset still applies, in apps/cms too', () => {
    expect(lint.findings('apps/cms/src/loose.ts')).toEqual([eqeqeq]);
  });

  test.each(ignored)('%s is ignored', (file) => {
    expect(lint.findings(file)).toEqual([]);
  });

  test('the run reports no other file', () => {
    expect(lint.files).toEqual(['apps/cms/src/loose.ts', ...outsideCms].sort());
  });
});

describe('oxlint-site.json through a plain extends in .oxlintrc.json', () => {
  let lint: ReturnType<typeof lintSiteRepo>;
  beforeAll(() => {
    lint = lintSiteRepo(extendsConfig);
  });

  test('the import rule and the apps/cms exemption apply', () => {
    expect(lint.findings('apps/marketing/src/page.tsx')).toEqual(confined);
    expect(lint.findings('apps/cms/src/payload.config.ts')).toEqual([]);
  });

  test('the base preset applies through the preset’s own extends', () => {
    expect(lint.findings('apps/cms/src/loose.ts')).toEqual([eqeqeq]);
  });

  test('the ignores do not: oxlint reads ignorePatterns only from the root config', () => {
    expect(lint.findings('packages/x/dist/index.js')).toEqual([...confined, eqeqeq].sort());
  });
});
