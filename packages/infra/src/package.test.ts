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
  const destination = mkdtempSync(join(tmpdir(), 'pebbletech-infra-pack-'));
  const output = execFileSync(command, [...args, 'pack', '--json', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  // prepack prints the build before the JSON report
  const report = JSON.parse(output.slice(output.indexOf('{\n'))) as { files: { path: string }[] };
  return report.files.map((file) => file.path).sort();
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
