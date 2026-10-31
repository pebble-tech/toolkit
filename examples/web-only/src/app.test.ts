import { defaultMocks, type Registration, runProgram } from '@pebbletech/infra/testing';
import type * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { notes, type NotesInputs } from './app.js';

const inputs: NotesInputs = {
  apex: 'pebbletech.my',
  cloudflareZoneId: 'zone-1',
  pgAdminUrl: 'postgresql://notes_admin:admin@sin.pg.psdb.cloud:5432/postgres',
  pgRuntime: { role: 'notes_app', password: 'runtime' },
};

// What Vercel answers when staging and prod look the shared project up by name.
const mocks: pulumi.runtime.Mocks = {
  ...defaultMocks,
  call(args) {
    if (args.token === 'vercel:index/getProject:getProject') return { ...args.inputs, id: `prj_${args.inputs.name}` };
    if (args.token === 'vercel:index/getCustomEnvironment:getCustomEnvironment') return { ...args.inputs, id: 'env_1' };
    return defaultMocks.call(args);
  },
};

const run = (stack: string) =>
  runProgram({ project: 'notes', stack, mocks }, () =>
    notes(stack === 'staging' || stack === 'prod' ? inputs : { pgAdminUrl: inputs.pgAdminUrl })
  );

const components = (resources: Registration[]) =>
  resources.filter((r) => r.type.startsWith('pebbletech:')).map((r) => `${r.type} ${r.name}`);

describe('the web-only program', () => {
  test.each([
    ['shared', ['pebbletech:index:Stage stage', 'pebbletech:index:VercelProject web']],
    ['pr-7', ['pebbletech:index:Stage stage', 'pebbletech:index:Database db']],
    ['staging', ['pebbletech:index:Stage stage', 'pebbletech:index:Database db', 'pebbletech:index:VercelProject web']],
    ['prod', ['pebbletech:index:Stage stage', 'pebbletech:index:Database db', 'pebbletech:index:VercelProject web']],
  ])('%s builds its components', async (stack, expected) => {
    expect(components((await run(stack)).resources)).toEqual(expected);
  });

  // pebble-infra writes each output in snake case; the workflow reads them by that name after `outputs` and `up`.
  test('prod exports every output deploy-production.yml reads', async () => {
    const workflow = readFileSync(join(import.meta.dirname, '../.github/workflows/deploy-production.yml'), 'utf8');
    const read = [...workflow.matchAll(/steps\.(?:before|up)\.outputs(?:\.json\))?\.(\w+)/g)].map(([, name]) => name);
    const { result } = await run('prod');
    const written = Object.keys(result).map((key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    expect([read.length > 0, read.filter((name) => !written.includes(name))]).toEqual([true, []]);
  });
});
