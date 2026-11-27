import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const packageDir = join(import.meta.dirname, '..');

// Runs the same pnpm that runs this test (pnpm sets npm_execpath), so the listing is what `pnpm publish` would ship.
function packedFiles(): string[] {
  const pnpm = process.env.npm_execpath ?? 'pnpm';
  const [command, args] = /\.[cm]?js$/.test(pnpm) ? [process.execPath, [pnpm]] : [pnpm, []];
  const destination = mkdtempSync(join(tmpdir(), 'pebbletech-cms-pack-'));
  const output = execFileSync(command, [...args, 'pack', '--json', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  // prepack prints the build before the JSON report
  const report = JSON.parse(output.slice(output.indexOf('{\n'))) as { files: { path: string }[] };
  return report.files.map((file) => file.path).sort();
}

/**
 * Imports a built module in a fresh Node with a resolve hook that throws on any specifier `refuse` matches, then runs
 * `then` (an expression over the module `m`). Returns what the child printed.
 */
function importRefusing(module: string, refuse: string, then = 'Object.keys(m).length'): string {
  const script = `
    import { registerHooks } from 'node:module';
    const refuse = new RegExp(${JSON.stringify(refuse)});
    registerHooks({
      resolve(specifier, context, next) {
        if (refuse.test(specifier)) throw new Error('refused import of ' + specifier);
        return next(specifier, context);
      },
    });
    const m = await import(${JSON.stringify(join(packageDir, 'dist', module))});
    console.log(String(await (${then})));
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  }).trim();
}

// prepack rebuilds dist/ with tsc first, which can pass vitest's 5 s default on a loaded machine.
test(
  'the packed tarball holds the compiled modules, README, LICENSE and package.json, and no tests',
  { timeout: 60_000 },
  () => {
    const modules = readdirSync(join(packageDir, 'src'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .flatMap((file) => [`dist/${file.replace(/\.ts$/, '.d.ts')}`, `dist/${file.replace(/\.ts$/, '.js')}`]);
    expect(packedFiles()).toEqual(['LICENSE', 'README.md', 'package.json', ...modules].sort());
  }
);

test('the main entry imports and builds a config without Next.js', { timeout: 60_000 }, () => {
  const secret = importRefusing(
    'index.js',
    '^(next|@payloadcms/next)(/|$)',
    '(await m.createCmsConfig()).secret.length'
  );
  expect(secret).toBe('64');
});

test(
  '@pebbletech/cms/site imports nothing but Node built-ins, so the marketing app needs no Payload',
  { timeout: 60_000 },
  () => {
    expect(importRefusing('site.js', '^(?!node:|\\.|/|file:)', 'typeof m.verifyPurgeRequest')).toBe('function');
  }
);
