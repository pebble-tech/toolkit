import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { lintStaged, presets } from './index.js';

const packageDir = join(import.meta.dirname, '..');
const repoRoot = join(packageDir, '..', '..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const packageJson = readJson(join(packageDir, 'package.json')) as {
  exports: Record<string, unknown>;
  files: string[];
};
const presetFiles = Object.values(presets).map((specifier) => specifier.replace('@pebbletech/config/', ''));

// Runs the same pnpm that runs this test (pnpm sets npm_execpath), so the listing is what `pnpm publish` would ship.
function packedFiles(): string[] {
  const pnpm = process.env.npm_execpath ?? 'pnpm';
  const [command, args] = /\.[cm]?js$/.test(pnpm) ? [process.execPath, [pnpm]] : [pnpm, []];
  const destination = mkdtempSync(join(tmpdir(), 'pebbletech-config-pack-'));
  const output = execFileSync(command, [...args, 'pack', '--json', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  // prepack prints the build before the JSON report
  const report = JSON.parse(output.slice(output.indexOf('{\n'))) as { files: { path: string }[] };
  return report.files.map((file) => file.path).sort();
}

describe('presets', () => {
  test.each(presetFiles)('%s parses as JSON', (file) => {
    expect(readJson(join(packageDir, file))).toBeTypeOf('object');
  });

  test('the manifest names every preset the package exports and ships', () => {
    const exportedPresets = Object.keys(packageJson.exports)
      .filter((key) => key.endsWith('.json') && key !== './package.json')
      .map((key) => key.slice(2));
    expect([...presetFiles].sort()).toEqual(exportedPresets.sort());
    expect(packageJson.files.filter((file) => file.endsWith('.json')).sort()).toEqual([...presetFiles].sort());
  });

  test('the packed tarball holds the presets, the compiled entry and nothing else', () => {
    expect(packedFiles()).toEqual(
      ['LICENSE', 'README.md', 'dist/index.d.ts', 'dist/index.js', 'package.json', ...presetFiles].sort()
    );
  });

  test("this repo's lint-staged map is the exported one", () => {
    const root = readJson(join(repoRoot, 'package.json')) as { 'lint-staged': unknown };
    expect(root['lint-staged']).toEqual(lintStaged);
  });
});
