import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { Database, DeployRole, Operators, Stage } from './index.js';
import { type Registration, runProgram } from './testing.js';

/**
 * What the engine received from programs that pass only the options 0.7.0 had: every URN, type, name, input, option
 * and dependency, and the policy JSON byte for byte. `compat.golden.json` was captured from 0.7.0's code (origin/main
 * 7ec1a37) before 0.8.0's options were added, and is never regenerated: a changed URN makes Pulumi replace a live
 * grant, default privilege or role policy.
 */
const PLANETSCALE = 'postgresql://postgres.abc123:admin-pw@sin.pg.psdb.cloud:6432/postgres?sslmode=require';
const RUNTIME = { role: 'basefresh_app', password: 'runtime-pw' };
const GITHUB = { org: 'pebble-tech', repo: 'basefresh' };

const database = (stack: string, args: { runtime?: typeof RUNTIME; pooler?: { host?: string; port?: number } }) =>
  runProgram({ project: 'basefresh', stack }, () => {
    const stage = new Stage('stage', { product: 'basefresh' });
    new Database('db', { stage, adminUrl: PLANETSCALE, ...args });
  });

const deployRole = (env: 'preview' | 'staging' | 'prod') =>
  runProgram({ project: 'basefresh-bootstrap', stack: env }, () => {
    new DeployRole('deploy', { product: 'basefresh', env, apex: 'pebbletech.my', github: GITHUB });
  });

const SCENARIOS: Record<string, () => Promise<{ resources: Registration[] }>> = {
  'database pr-7': () => database('pr-7', {}),
  'database staging, passed runtime': () => database('staging', { runtime: RUNTIME }),
  'database staging, made runtime': () => database('staging', {}),
  'database staging, pooler host and port': () =>
    database('staging', { runtime: RUNTIME, pooler: { host: 'pool.example.com', port: 7432 } }),
  'database prod, passed runtime': () => database('prod', { runtime: RUNTIME }),
  'database prod, made runtime': () => database('prod', {}),
  'operators and database in prod': () =>
    runProgram({ project: 'basefresh', stack: 'prod' }, () => {
      const stage = new Stage('stage', { product: 'basefresh' });
      new Operators('operators', { stage, adminUrl: PLANETSCALE, members: ['pscale_api_alice', 'pscale_api_bob'] });
      new Database('db', { stage, adminUrl: PLANETSCALE });
    }),
  'operators shared': () =>
    runProgram({ project: 'basefresh', stack: 'shared' }, () => {
      const stage = new Stage('stage', { product: 'basefresh' });
      new Operators('operators', { stage, adminUrl: PLANETSCALE, members: ['pscale_api_alice'] });
    }),
  'operators cluster, adopting': () =>
    runProgram({ project: 'pebble-cluster-operators', stack: 'pebble-stg' }, () => {
      new Operators('operators', {
        cluster: 'pebble-stg',
        adoptExisting: true,
        adminUrl: PLANETSCALE,
        members: ['pscale_api_alice', 'pscale_api_bob'],
      });
    }),
  'deploy role preview': () => deployRole('preview'),
  'deploy role staging': () => deployRole('staging'),
  'deploy role prod': () => deployRole('prod'),
};

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
      inputs: r.inputs,
      secretInputs: [...r.secretInputs].sort(),
      outputs: r.outputs ?? null,
    }))
    .sort((a, b) => a.urn.localeCompare(b.urn));

const golden: Record<string, ReturnType<typeof recorded>> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./compat.golden.json', import.meta.url)), 'utf8')
);

describe('compatibility with 0.7.0', () => {
  test('every captured program is still checked', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(golden).sort());
  });

  test.each(Object.keys(SCENARIOS))('%s: the engine receives what it received from 0.7.0', async (scenario) => {
    const { resources } = await SCENARIOS[scenario]!();
    expect(recorded(resources)).toEqual(golden[scenario]);
  });

  test.each(['staging', 'prod'])('deploy role %s: the policy JSON is the same string as 0.7.0 sent', async (env) => {
    const { resources } = await SCENARIOS[`deploy role ${env}`]!();
    const policy = resources.find((r) => r.type === 'aws:iam/rolePolicy:RolePolicy')!.inputs.policy;
    const before = golden[`deploy role ${env}`]!.find((r) => r.type === 'aws:iam/rolePolicy:RolePolicy')!.inputs.policy;
    expect([typeof policy, policy]).toEqual(['string', before]);
  });
});
