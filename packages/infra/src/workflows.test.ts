import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { stringify } from 'yaml';

import type { EntriesModule } from './config.js';
import { checkWorkflows, type WorkflowChecks } from './testing.js';

// Workflows shaped unlike the basefresh example (its own tests cover that one): written to files and checked the way a
// product's test calls the helper.

const REGION = 'xx-test-1';
const ENTRIES: EntriesModule = {
  entries: [
    {
      key: 'aws:region',
      env: 'AWS_REGION',
      secret: false,
      required: true,
      stacks: ['shared', 'preview', 'staging', 'prod'],
    },
    { key: 'pgAdminUrl', env: 'PG_ADMIN_URL', secret: true, required: true, stacks: ['preview', 'staging', 'prod'] },
  ],
  previewDatabase: true,
};
const TABLE = ['ROLE', 'PG_ADMIN_URL'];

const state = (account: 'stg' | 'prd', path: string, key: string) => ({
  PULUMI_BACKEND_URL: `s3://pebble-${account}-pulumi-state/acme/${path}?region=${REGION}`,
  PULUMI_SECRETS_PROVIDER: `awskms://alias/pebble-${account}-pulumi-${key}?region=${REGION}`,
});
const credentials = {
  uses: 'aws-actions/configure-aws-credentials@v6',
  with: { 'role-to-assume': '${{ secrets.ROLE }}', 'aws-region': REGION },
};
const VALUES = { PEBBLE_INFRA_VALUES: '${{ toJSON(secrets) }}' };

/** Read the URL, migrate when there is one, up, and migrate a first deploy from up's own output. */
const migrateFirst = (stack: string, read = 'steps.before.outputs.database_url') => [
  ...(read.startsWith('steps.before')
    ? [{ id: 'before', run: `pnpm --dir infra exec pebble-infra outputs ${stack} --github-output --if-exists` }]
    : []),
  { name: 'Migrate', if: `${read} != ''`, env: { DATABASE_URL: `\${{ ${read} }}` }, run: 'pnpm migrate' },
  {
    id: 'up',
    env: VALUES,
    run: `pnpm --dir infra exec pebble-infra up ${stack} --entries dist/entries.js --clear-lock`,
  },
  { if: `${read} == ''`, env: { DATABASE_URL: '${{ steps.up.outputs.database_url }}' }, run: 'pnpm migrate' },
];

function write(workflows: Record<string, object>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pebble-infra-workflows-'));
  return Object.entries(workflows).map(([file, workflow]) => {
    writeFileSync(join(dir, file), stringify(workflow));
    return join(dir, file);
  });
}

const check = (workflows: Record<string, object>, options: Partial<WorkflowChecks> = {}) =>
  checkWorkflows({
    workflows: write(workflows),
    product: 'acme',
    region: REGION,
    entries: ENTRIES,
    secrets: { staging: TABLE },
    database: { output: 'database_url', stacks: ['preview', 'staging', 'prod'] },
    ...options,
  });
const rules = (violations: { rule: string; job: string }[]) => violations.map(({ rule, job }) => [rule, job]);

describe('checkWorkflows on workflows shaped differently', () => {
  test('one job deploys staging and prod from a matrix list, each leg in its own environment and group', () => {
    const ship = {
      on: { push: { branches: ['main'] } },
      jobs: {
        ship: {
          'runs-on': 'ubuntu-latest',
          strategy: {
            matrix: {
              include: [
                { stack: 'staging', environment: 'staging', account: 'stg' },
                { stack: 'prod', environment: 'production', account: 'prd' },
              ],
            },
          },
          environment: '${{ matrix.environment }}',
          concurrency: { group: 'pulumi-${{ matrix.stack }}', 'cancel-in-progress': false },
          env: state('${{ matrix.account }}' as 'stg', '${{ matrix.stack }}', '${{ matrix.stack }}'),
          steps: [credentials, ...migrateFirst('${{ matrix.stack }}')],
        },
      },
    };
    expect(check({ 'ship.yml': ship }, { secrets: { staging: TABLE, production: TABLE } })).toEqual([]);
    // The same job with prod's leg pointed at staging's state is caught on that leg alone.
    ship.jobs.ship.strategy.matrix.include[1]!.account = 'stg';
    const leg = 'ship.yml#ship (matrix.stack=prod, matrix.environment=production, matrix.account=stg) step';
    const violations = check({ 'ship.yml': ship }, { secrets: { staging: TABLE, production: TABLE } });
    expect(violations.map((v) => [v.rule, v.message.startsWith(leg)])).toEqual([
      ['state', true],
      ['state', true],
      ['state', true],
      ['state', true],
    ]);
  });

  test('the stack comes from a choice input through the step env, and each option is checked', () => {
    const apply = {
      on: { workflow_dispatch: { inputs: { stack: { type: 'choice', options: ['shared', 'staging'] } } } },
      jobs: {
        apply: {
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          concurrency: { group: 'stg-state', 'cancel-in-progress': false },
          env: { ...state('stg', '${{ github.event.inputs.stack }}', 'staging'), STACK: '${{ inputs.stack }}' },
          steps: [credentials, ...migrateFirst('"$STACK"')],
        },
      },
    };
    expect(check({ 'apply.yml': apply })).toEqual([]);
  });

  test('a stack the helper cannot read fails until the job declares it', () => {
    const release = {
      on: { push: { branches: ['main'] } },
      jobs: {
        plan: {
          'runs-on': 'ubuntu-latest',
          outputs: { stack: '${{ steps.plan.outputs.stack }}' },
          steps: [{ id: 'plan', run: 'echo stack=staging >> "$GITHUB_OUTPUT"' }],
        },
        deploy: {
          needs: 'plan',
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          concurrency: { group: 'pulumi-staging' },
          env: state('stg', 'staging', 'staging'),
          steps: [credentials, ...migrateFirst('${{ needs.plan.outputs.stack }}')],
        },
      },
    };
    const refused = check({ 'release.yml': release });
    expect(rules(refused)).toEqual([
      ['stack', 'release.yml#deploy'],
      ['stack', 'release.yml#deploy'],
    ]);
    expect(refused[0]!.message).toContain('declare it in the `stacks` option under "release.yml#deploy"');
    expect(check({ 'release.yml': release }, { stacks: { 'release.yml#deploy': ['staging'] } })).toEqual([]);
  });

  test('pulumi run directly, other than login, fails: its stack and lock are not read', () => {
    const raw = {
      on: { push: {} },
      jobs: {
        deploy: {
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'pulumi login "$PULUMI_BACKEND_URL"\npulumi up --yes --stack staging' }],
        },
      },
    };
    expect(check({ 'raw.yml': raw }, { secrets: {} })).toEqual([
      { rule: 'stack', job: 'raw.yml#deploy', message: expect.stringContaining('runs `pulumi up` directly') },
    ]);
  });

  test('a lone job that clears staging’s lock holds no group, so two of its runs can overlap', () => {
    const deploy = {
      on: { push: {} },
      jobs: {
        deploy: {
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          env: state('stg', 'staging', 'staging'),
          steps: [credentials, ...migrateFirst('staging')],
        },
      },
    };
    expect(check({ 'd.yml': deploy })).toEqual([
      { rule: 'lock', job: 'd.yml#deploy', message: expect.stringContaining('in no concurrency group') },
    ]);
  });

  describe('two jobs on staging, one of which clears its lock', () => {
    const workflow = (preview: object) => ({
      on: { push: {} },
      concurrency: { group: 'staging-${{ github.ref }}', 'cancel-in-progress': false, queue: 'max' },
      jobs: {
        deploy: {
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          env: state('stg', 'staging', 'staging'),
          steps: [credentials, ...migrateFirst('staging')],
        },
        preview: {
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          env: state('stg', 'staging', 'staging'),
          steps: [
            credentials,
            { env: VALUES, run: 'pnpm --dir infra exec pebble-infra preview staging --entries e.js' },
          ],
          ...preview,
        },
      },
    });

    test('run side by side when they share only the workflow’s group', () => {
      expect(rules(check({ 'stg.yml': workflow({}) }))).toEqual([['lock', 'stg.yml#preview']]);
    });

    test('pass once one needs the other', () => {
      expect(check({ 'stg.yml': workflow({ needs: 'deploy' }) })).toEqual([]);
    });

    test('fail when the workflow’s group may cancel the run in progress', () => {
      const cancelling = workflow({ needs: 'deploy' });
      cancelling.concurrency['cancel-in-progress'] = true;
      expect(rules(check({ 'stg.yml': cancelling }))).toEqual([['lock', 'stg.yml#deploy']]);
    });
  });

  test('a job output carries the URL another job read before up', () => {
    const group = { group: 'pulumi-staging', 'cancel-in-progress': false, queue: 'max' };
    const deploy = {
      on: { push: {} },
      jobs: {
        read: {
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          concurrency: group,
          env: state('stg', 'staging', 'staging'),
          outputs: { url: '${{ steps.before.outputs.database_url }}' },
          steps: [credentials, { id: 'before', run: 'pebble-infra outputs staging --github-output --if-exists' }],
        },
        apply: {
          needs: ['read'],
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          concurrency: group,
          env: state('stg', 'staging', 'staging'),
          steps: [credentials, ...migrateFirst('staging', 'needs.read.outputs.url')],
        },
      },
    };
    expect(check({ 'deploy.yml': deploy })).toEqual([]);
  });

  describe('migrate before up', () => {
    const job = (steps: object[]) => ({
      on: { push: {} },
      jobs: {
        deploy: {
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          concurrency: { group: 'pulumi-staging' },
          env: state('stg', 'staging', 'staging'),
          steps: [credentials, ...steps],
        },
      },
    });
    const [before, migrate, up, first] = migrateFirst('staging') as [object, { if?: string }, object, object];

    test('an unguarded migrate fails: on a first deploy it would run with no URL', () => {
      const { if: _guard, ...unguarded } = migrate;
      expect(check({ 'd.yml': job([before, unguarded, up, first]) })).toEqual([
        { rule: 'migrate', job: 'd.yml#deploy', message: expect.stringContaining('with no guard on') },
      ]);
    });

    test('a deploy with no first-deploy migration fails', () => {
      expect(check({ 'd.yml': job([before, migrate, up]) })).toEqual([
        {
          rule: 'migrate',
          job: 'd.yml#deploy',
          message: expect.stringContaining("never migrates staging's first deploy"),
        },
      ]);
    });

    test('a product with no database is not asked to migrate', () => {
      expect(check({ 'd.yml': job([up]) }, { database: false })).toEqual([]);
    });
  });

  describe('values an up needs', () => {
    const job = (env: Record<string, string>) => ({
      on: { push: {} },
      jobs: {
        deploy: {
          'runs-on': 'ubuntu-latest',
          environment: 'staging',
          concurrency: { group: 'pulumi-staging' },
          env: state('stg', 'staging', 'staging'),
          steps: [credentials, { env, run: 'pebble-infra up staging --entries e.js --clear-lock' }],
        },
      },
    });

    test('fail without PEBBLE_INFRA_VALUES or the variable in the step env', () => {
      expect(check({ 'd.yml': job({}) }, { database: false }).map((v) => [v.rule, v.message])).toEqual([
        ['secrets', expect.stringContaining('which needs PG_ADMIN_URL; the step')],
        ['secrets', 'environment staging sets PG_ADMIN_URL, which no job reads'],
      ]);
    });

    test('pass with the variable set from a secret in the step env', () => {
      const env = { PG_ADMIN_URL: '${{ secrets.PG_ADMIN_URL }}' };
      expect(check({ 'd.yml': job(env) }, { database: false })).toEqual([]);
    });
  });
});
