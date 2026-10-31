import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

// In changesets pre mode `latest` is the last stable release, so a product copying a bare install gets a version without
// this one's changes. Leaving pre mode makes this test ask for the tag to come out of each command again.
test('every install command in the READMEs names the next tag exactly while the repository is in pre mode', () => {
  const root = join(packageDir, '../..');
  const preFile = join(root, '.changeset/pre.json');
  const pre = existsSync(preFile) && (JSON.parse(readFileSync(preFile, 'utf8')) as { mode?: string }).mode === 'pre';
  const installs = ['README.md', 'packages/infra/README.md'].flatMap((file) =>
    [...readFileSync(join(root, file), 'utf8').matchAll(/pnpm [^`\n]*\badd\b[^`\n]*@pebbletech\/infra[^\s`]*/g)].map(
      (m) => `${file}: ${m[0]}`
    )
  );
  expect(installs.length).toBeGreaterThanOrEqual(3);
  expect(installs.filter((line) => /@pebbletech\/infra@next(?:\s|$)/.test(line) !== pre)).toEqual([]);
});
