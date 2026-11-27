import { readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { Stage, VercelProject, type VercelProjectArgs } from './index.js';
import { type Registration, runProgram } from './testing.js';

/**
 * What the engine received from `VercelProject` programs that pass only the options 0.7.0 had: every URN, type, name,
 * input, option and dependency. `vercel-compat.golden.json` was captured from 0.7.0's code (origin/main 4738a3b) before
 * the custom and apex domain options were added, and is never regenerated: a changed URN makes Pulumi replace a live
 * project, environment variable, domain or DNS record.
 */
const PROJECT = {
  rootDirectory: 'apps/web',
  buildCommand: "cd ../.. && pnpm --filter '@base/app' build",
  installCommand: 'cd ../.. && pnpm install --prod=false',
  devCommand: 'cd ../.. && pnpm dev:app',
};

const vercel = (stack: string, args: Omit<VercelProjectArgs, 'stage'>) =>
  runProgram({ project: 'basefresh', stack }, () => {
    const stage = new Stage('stage', { product: 'basefresh' });
    new VercelProject('web', { stage, ...args });
  });

const env = {
  vars: { APP_BASE_URL: 'https://app', NEXT_PUBLIC_SITE: 'basefresh' },
  secrets: { DATABASE_URL: 'postgresql://x', BETTER_AUTH_SECRET: 'shh' },
};

const SCENARIOS: Record<string, () => Promise<{ resources: Registration[] }>> = {
  'shared, defaults': () => vercel('shared', { project: PROJECT }),
  'shared, every setting and a team': () =>
    vercel('shared', {
      teamId: 'team_1',
      project: {
        ...PROJECT,
        name: 'basefresh-site',
        outputDirectory: '.next',
        nodeVersion: '22.x',
        customEnvironments: ['staging', 'qa'],
        protection: 'all_deployments',
        skewProtection: false,
      },
    }),
  'staging, no domain': () => vercel('staging', { projectId: 'prj_123', customEnvironmentId: 'env_staging', ...env }),
  'staging, domain': () =>
    vercel('staging', {
      projectId: 'prj_123',
      customEnvironmentId: 'env_staging',
      teamId: 'team_1',
      ...env,
      domain: { hostname: 'app-basefresh-stg.pebbletech.my', zoneId: 'zone-1' },
    }),
  'prod, no domain': () => vercel('prod', { projectId: 'prj_123', ...env }),
  'prod, domain': () =>
    vercel('prod', {
      projectId: 'prj_123',
      teamId: 'team_1',
      ...env,
      domain: { hostname: 'app-basefresh.pebbletech.my', zoneId: 'zone-1' },
    }),
  'prod, domain only': () =>
    vercel('prod', { projectId: 'prj_123', domain: { hostname: 'www-basefresh.pebbletech.my', zoneId: 'zone-1' } }),
};

/** The placeholder's local copies live under this user's temporary directory: the same files on every machine. */
const PLACEHOLDER = join(tmpdir(), `pebbletech-infra-placeholder-${process.getuid?.() ?? userInfo().username}`);
const portable = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null).replaceAll(PLACEHOLDER, '<tmp>'));

/** A registration as the engine received it, in a fixed order: the engine registers in no fixed order. */
const recorded = (resources: Registration[]) =>
  resources
    .map((r) => ({
      urn: r.urn,
      type: r.type,
      name: r.name,
      parent: r.parent,
      custom: r.custom,
      protect: r.protect,
      retainOnDelete: r.retainOnDelete,
      deleteBeforeReplace: r.deleteBeforeReplace,
      importId: r.importId,
      ignoreChanges: r.ignoreChanges,
      dependencies: [...r.dependencies].sort(),
      inputs: portable(r.inputs),
      secretInputs: [...r.secretInputs].sort(),
      outputs: portable(r.outputs),
    }))
    .sort((a, b) => a.urn.localeCompare(b.urn));

const golden: Record<string, ReturnType<typeof recorded>> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./vercel-compat.golden.json', import.meta.url)), 'utf8')
);

describe('VercelProject compatibility with 0.7.0', () => {
  test('every captured program is still checked', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(golden).sort());
  });

  test.each(Object.keys(SCENARIOS))('%s: the engine receives what it received from 0.7.0', async (scenario) => {
    const { resources } = await SCENARIOS[scenario]!();
    expect(recorded(resources)).toEqual(golden[scenario]);
  });
});
