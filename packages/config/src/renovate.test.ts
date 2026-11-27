import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// The shared Renovate preset is read from GitHub, not shipped: these tests hold its rules in place without Renovate.
// What Renovate does with them (last matching rule wins, branch-level auto-merge) was proven against Renovate itself
// when the preset was written; this file stops an edit from quietly widening auto-merge or reordering the rules.

interface PackageRule {
  matchPackageNames?: string[];
  matchUpdateTypes?: string[];
  matchDatasources?: string[];
  matchJsonata?: string[];
  matchDepNames?: string[];
  groupName?: string | null;
  separateMinorPatch?: boolean;
  automerge?: boolean;
}
interface Preset {
  automerge?: boolean;
  automergeType?: string;
  platformAutomerge?: boolean;
  vulnerabilityAlerts?: Record<string, unknown>;
  customManagers: { managerFilePatterns: string[]; matchStrings: string[] }[];
  packageRules: PackageRule[];
}

const packageDir = join(import.meta.dirname, '..');
const repoRoot = join(packageDir, '..', '..');
const read = (path: string): string => readFileSync(path, 'utf8');
const preset = JSON.parse(read(join(packageDir, 'renovate.json'))) as Preset;
const optIn = JSON.parse(read(join(packageDir, 'renovate-automerge.json'))) as Preset;
// A repo that extends both: Renovate puts a preset's rules in extends order, so the opt-in's come after the base's
const combinedRules = [...preset.packageRules, ...optIn.packageRules];
const rules = preset.packageRules;

const payload = ['payload', '/^@payloadcms\\//'];
const next = ['next', '/^@next\\//', 'eslint-config-next'];
const automergeRules = combinedRules.filter((rule) => rule.automerge === true);

describe('the shared Renovate preset', () => {
  test('the minor and patch catch-all is the first rule and names no packages, so later groups win', () => {
    expect(rules[0]).toEqual({
      description: expect.any(String),
      matchUpdateTypes: ['minor', 'patch'],
      groupName: 'minor and patch',
    });
  });

  test.each([
    ['payload', payload],
    ['next', next],
  ])('%s is one npm group whose patches get their own branch', (groupName, packages) => {
    expect(rules.filter((rule) => rule.groupName === groupName)).toEqual([
      {
        description: expect.any(String),
        matchDatasources: ['npm'],
        matchPackageNames: packages,
        groupName,
        separateMinorPatch: true,
      },
    ]);
  });

  // No rule, and no top-level or vulnerability-alert setting, sets automerge: so no update type (patch, minor, major,
  // security) of any package (Payload, Next.js or other) can auto-merge from the base preset alone
  test('on its own never auto-merges anything: no rule, top-level or security setting sets automerge', () => {
    expect(rules.filter((rule) => 'automerge' in rule)).toEqual([]);
    expect(preset.automerge).toBeUndefined();
    expect(preset.vulnerabilityAlerts?.automerge).toBeUndefined();
  });

  test('on its own leaves GitHub auto-merge and the merge type unset', () => {
    expect([preset.automergeType, preset.platformAutomerge]).toEqual([undefined, undefined]);
  });

  test('the opt-in preset is only auto-merge: the two rules, the merge type and platform auto-merge', () => {
    expect(Object.keys(optIn).sort()).toEqual([
      '$schema',
      'automergeType',
      'description',
      'packageRules',
      'platformAutomerge',
    ]);
    expect([optIn.automergeType, optIn.platformAutomerge]).toEqual(['pr', true]);
    expect(optIn.packageRules).toEqual(automergeRules);
  });

  test('only two rules auto-merge once a repo opts in: Payload and Next.js npm patches that are not breaking, and their patch or minor security fixes', () => {
    expect(automergeRules).toEqual([
      {
        description: expect.any(String),
        matchDatasources: ['npm'],
        matchPackageNames: [...payload, ...next],
        matchUpdateTypes: ['patch'],
        matchJsonata: ['$not(isBreaking = true)'],
        automerge: true,
      },
      {
        description: expect.any(String),
        matchDatasources: ['npm'],
        matchPackageNames: [...payload, ...next],
        matchUpdateTypes: ['patch', 'minor'],
        matchJsonata: ['isVulnerabilityAlert = true'],
        automerge: true,
      },
    ]);
  });

  test('the auto-merge rules come after every group, and nothing else turns auto-merge on', () => {
    const lastGroup = Math.max(...combinedRules.map((rule, index) => (rule.groupName === undefined ? -1 : index)));
    expect(combinedRules.slice(-automergeRules.length)).toEqual(automergeRules);
    expect(combinedRules.length - automergeRules.length).toBeGreaterThan(lastGroup);
    expect([optIn.automerge, optIn.vulnerabilityAlerts]).toEqual([undefined, undefined]);
  });

  test.each([
    '.github/workflows/site-build.yml',
    '.github/site-deploy/stubs/site-build.yml',
    '.github/site-deploy/stubs/site-deploy.yml',
  ])('the pin manager reads every toolkit pin in %s, and a toolkit-ref below it', (file) => {
    const [manager] = preset.customManagers;
    const content = read(join(repoRoot, file));
    const pins = [...content.matchAll(/uses: pebble-tech\/toolkit\/.+@([0-9a-f]{40}) # @pebbletech\/infra@(\S+)/g)];
    const refs = [...content.matchAll(/toolkit-ref: '?([0-9a-f]{40})'?/g)].map((match) => match[1]);
    const matches = [...content.matchAll(new RegExp(manager.matchStrings[0], 'g'))];

    expect(pins.length).toBeGreaterThan(0);
    expect(matches.map((match) => [match.groups?.currentDigest, match.groups?.currentValue])).toEqual(
      pins.map((pin) => [pin[1], pin[2]])
    );
    // Renovate rewrites the digest everywhere in the matched text, so a toolkit-ref inside the match moves with it
    expect(refs.filter((ref) => !matches.some((match) => match[0].includes(`toolkit-ref: '${ref}'`)))).toEqual([]);
    expect(
      new RegExp(manager.managerFilePatterns[0].slice(1, -1)).test(`.github/workflows/${file.split('/').pop()}`)
    ).toBe(true);
  });
});

describe("toolkit's own renovate.json", () => {
  const config = JSON.parse(read(join(repoRoot, 'renovate.json'))) as {
    extends: string[];
    packageRules: PackageRule[];
  };

  test('extends the preset by the line the README gives', () => {
    expect(config.extends).toEqual(['github>pebble-tech/toolkit//packages/config/renovate']);
    expect(read(join(packageDir, 'README.md'))).toContain(`"extends": ${JSON.stringify(config.extends)}`);
  });

  test('keeps majors out of its own groups, so each major stays one PR', () => {
    expect(config.packageRules.map((rule) => rule.matchUpdateTypes)).toEqual(config.packageRules.map(() => ['!major']));
  });
});
