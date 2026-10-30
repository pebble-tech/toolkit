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
    roleSecret: 'ROLE',
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
      concurrency: { group: 'staging', 'cancel-in-progress': false, queue: 'max' },
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
      expect(rules(check({ 'stg.yml': cancelling }))).toEqual([
        ['lock', 'stg.yml#deploy'],
        ['lock', 'stg.yml#preview'],
      ]);
    });
  });

  test('a URL read in another job does not count: the read is in the deploying job', () => {
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
    expect(rules(check({ 'deploy.yml': deploy }))).toEqual([['migrate', 'deploy.yml#apply']]);
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
        {
          rule: 'migrate',
          job: 'd.yml#deploy',
          message: expect.stringContaining(
            "under if: (none); the guard is exactly `if: steps.before.outputs.database_url != ''`"
          ),
        },
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

// The T3 review's probes (review-t3.md): one valid staging deploy, then one change each. Each bad probe must fail on the
// rule named; each good one must pass.
describe('review probes', () => {
  const group = { group: 'pulumi-staging', 'cancel-in-progress': false, queue: 'max' };
  const deploy = () => ({
    'runs-on': 'ubuntu-latest',
    environment: 'staging',
    concurrency: { ...group } as Record<string, unknown>,
    env: state('stg', 'staging', 'staging') as Record<string, string>,
    steps: [credentials, ...migrateFirst('staging')].map((step) => structuredClone(step)) as Record<string, any>[],
  });
  const reader = (extra: object = {}) => ({
    'runs-on': 'ubuntu-latest',
    environment: 'staging',
    env: state('stg', 'staging', 'staging'),
    steps: [credentials, { env: VALUES, run: 'pebble-infra preview staging --entries e.js' }],
    ...extra,
  });
  const workflow = (change: (w: Record<string, any>) => void) => {
    const w: Record<string, any> = { on: { push: {} }, jobs: { deploy: deploy() } };
    change(w);
    return w;
  };
  const run = (change: (w: Record<string, any>) => void, options: Partial<WorkflowChecks> = {}) =>
    rules(check({ 'p.yml': workflow(change) }, options));
  const toWorkflowGroup = (w: Record<string, any>) => {
    w.concurrency = w.jobs.deploy.concurrency;
    delete w.jobs.deploy.concurrency;
  };

  test('the unchanged deploy passes', () => {
    expect(run(() => {})).toEqual([]);
  });

  test.each([
    // lock-1
    [
      'nonclearer-cancels-holder',
      (w: any) => (w.jobs.read = reader({ concurrency: { ...group, 'cancel-in-progress': true } })),
      [['lock', 'p.yml#read']],
    ],
    [
      'nonclearer-workflow-cancels',
      (w: any) => {
        w.concurrency = { group: 'run', 'cancel-in-progress': true };
        w.jobs.read = reader({ concurrency: group });
      },
      [
        ['lock', 'p.yml#deploy'],
        ['lock', 'p.yml#read'],
      ],
    ],
    // lock-2
    [
      'run-specific-group',
      (w: any) => (w.jobs.deploy.concurrency.group = 'pulumi-staging-${{ github.run_id }}'),
      [['lock', 'p.yml#deploy']],
    ],
    // lock-3
    [
      'concurrent-matrix-staging',
      (w: any) => {
        toWorkflowGroup(w);
        w.jobs.deploy.strategy = { matrix: { runner: ['ubuntu-latest', 'ubuntu-24.04'] } };
      },
      [['lock', 'p.yml#deploy']],
    ],
    // migrate-1
    [
      'both-migrations-disabled',
      (w: any) => {
        w.jobs.deploy.steps[2].if = "false && steps.before.outputs.database_url != ''";
        w.jobs.deploy.steps[4].if = "false && steps.before.outputs.database_url == ''";
      },
      [
        ['migrate', 'p.yml#deploy'],
        ['migrate', 'p.yml#deploy'],
      ],
    ],
    [
      'first-deploy-never-migrates',
      (w: any) => (w.jobs.deploy.steps[4].if = "steps.before.outputs.database_url != ''"),
      [['migrate', 'p.yml#deploy']],
    ],
    [
      'conditional-staging-migrate',
      (w: any) =>
        (w.jobs.deploy.steps[2].if =
          "steps.before.outputs.database_url != '' && github.event_name == 'workflow_dispatch'"),
      [['migrate', 'p.yml#deploy']],
    ],
    [
      'read-disabled-for-existing-stack',
      (w: any) => (w.jobs.deploy.steps[1].if = 'false'),
      [['migrate', 'p.yml#deploy']],
    ],
    // stack-1
    [
      'shell-overrides-stack',
      (w: any) => {
        w.jobs.deploy.env.STACK = 'staging';
        w.jobs.deploy.steps[3].run = 'STACK=prod\npebble-infra up "$STACK" --entries e.js --clear-lock';
      },
      [['stack', 'p.yml#deploy']],
    ],
    [
      'stack-in-env-context',
      (w: any) => {
        w.jobs.deploy.env.STACK = 'staging';
        w.jobs.deploy.steps[3].run = 'pebble-infra up "${{ env.STACK }}" --entries e.js --clear-lock';
      },
      [['stack', 'p.yml#deploy']],
    ],
    // stack-2
    [
      'composite-lock-clear',
      (w: any) => (w.jobs.rogue = reader({ steps: [credentials, { uses: './.github/actions/clear-staging' }] })),
      [['stack', 'p.yml#rogue']],
    ],
    // secrets-1
    [
      'discarded-secret-field',
      (w: any) => (w.jobs.deploy.steps[2]['working-directory'] = '${{ secrets.MISSING_DIR }}'),
      [['secrets', 'p.yml#deploy']],
    ],
    [
      'secret-in-container-env',
      (w: any) => (w.jobs.deploy.container = { image: 'node:24', env: { TOKEN: '${{ secrets.MISSING_TOKEN }}' } }),
      [['secrets', 'p.yml#deploy']],
    ],
    [
      'missing-dynamic-token',
      (w: any) => (w.jobs.deploy.steps[2].env.DEPLOY_TOKEN = "${{ secrets[format('MISSING_{0}', 'TOKEN')] }}"),
      [['secrets', 'p.yml#deploy']],
    ],
    // secrets-2
    [
      'computed-default-values',
      (w: any) => (w.jobs.deploy.steps[3].env = { ...VALUES, PG_ADMIN_URL: '   ' }),
      [['secrets', 'p.yml#deploy']],
      { secrets: { staging: ['ROLE'] } },
    ],
    [
      'derived-overwrites-required',
      () => {},
      [['secrets', 'entries']],
      { entries: { ...ENTRIES, derive: () => ({ PG_ADMIN_URL: '' }) } },
    ],
    // parity-1
    [
      'wrong-role-secret-read-all',
      (w: any) => {
        w.jobs.deploy.steps[0] = {
          ...credentials,
          with: { ...credentials.with, 'role-to-assume': '${{ secrets.PG_ADMIN_URL }}' },
        };
        w.jobs.deploy.steps.push({ env: { ROLE: '${{ secrets.ROLE }}' }, run: 'test -n "$ROLE"' });
      },
      [['state', 'p.yml#deploy']],
    ],
  ] as [string, (w: any) => void, string[][], Partial<WorkflowChecks>?][])(
    '%s fails',
    (_name, change, expected, options) => {
      expect(run(change, options)).toEqual(expected);
    }
  );

  test.each([
    [
      'max-parallel: 1 serialises the matrix copies',
      (w: any) => {
        toWorkflowGroup(w);
        w.jobs.deploy.strategy = { 'max-parallel': 1, matrix: { runner: ['ubuntu-latest', 'ubuntu-24.04'] } };
      },
    ],
    [
      'a declared local action shares the deploy’s group',
      (w: any) =>
        (w.jobs.rogue = reader({
          concurrency: group,
          steps: [credentials, { uses: './.github/actions/clear-staging' }],
        })),
    ],
    [
      'a stack in an env variable, declared',
      (w: any) => {
        w.jobs.deploy.env.STACK = 'staging';
        w.jobs.deploy.steps[3].run = 'pebble-infra up "$STACK" --entries e.js --clear-lock';
      },
    ],
    ['a derived entry whose declared source is in the table', () => {}],
  ] as [string, (w: any) => void][])('%s passes', (_name, change) => {
    expect(
      run(change, {
        stacks: { 'p.yml#rogue': ['staging'], 'p.yml#deploy': ['staging'] },
        entries: { ...ENTRIES, derive: () => ({}) },
        derived: { PG_ADMIN_URL: ['PG_ADMIN_URL'] },
      })
    ).toEqual([]);
  });

  test('independent PR stacks hold their own groups; two groups on one PR stack fail', () => {
    const pr = (n: number, groupName: string) => ({
      ...deploy(),
      environment: 'preview',
      concurrency: { group: groupName, 'cancel-in-progress': true },
      env: state('stg', 'preview', 'preview'),
      steps: [credentials, ...migrateFirst(`pr-${n}`)],
    });
    const options = { secrets: { preview: TABLE } };
    expect(
      check({ 'pr.yml': { on: { push: {} }, jobs: { one: pr(1, 'preview-1'), two: pr(2, 'preview-2') } } }, options)
    ).toEqual([]);
    expect(
      rules(
        check({ 'pr.yml': { on: { push: {} }, jobs: { one: pr(1, 'preview-1'), two: pr(1, 'preview-2') } } }, options)
      )
    ).toEqual([['lock', 'pr.yml#two']]);
  });
});

// The T3 review's round-2 probes: each infers a value that is not written as a literal, and must fail.
describe('review probes, round 2', () => {
  const group = { group: 'pulumi-staging', 'cancel-in-progress': false, queue: 'max' };
  const deploy = (steps = migrateFirst('staging')) => ({
    'runs-on': 'ubuntu-latest',
    environment: 'staging',
    concurrency: { ...group } as Record<string, unknown> | undefined,
    env: state('stg', 'staging', 'staging') as Record<string, string>,
    steps: [credentials, ...steps].map((step) => structuredClone(step)) as Record<string, any>[],
  });
  const one = (change: (job: ReturnType<typeof deploy>) => void, options: Partial<WorkflowChecks> = {}) => {
    const job = deploy();
    change(job);
    return rules(check({ 'p.yml': { on: { push: {} }, jobs: { deploy: job } } }, options));
  };
  const stackFrom = (script: string) => (job: ReturnType<typeof deploy>) => {
    job.env.STACK = 'staging';
    job.steps[3]!.run = `${script}pebble-infra up "$STACK" --entries e.js --clear-lock`;
  };

  test.each([
    ['printf-v-overrides-stack', stackFrom('printf -v STACK %s prod\n')],
    ['source-overrides-stack', stackFrom('source ./deploy-target.sh\n')],
    ['yaml-env-stack', stackFrom('')],
  ])('%s: a stack in a variable is not read', (_name, change) => {
    expect(one(change)).toEqual([['stack', 'p.yml#deploy']]);
  });

  test('dynamic-matrix-copies-staging: a matrix that is not a literal mapping refuses', () => {
    const job = deploy();
    delete job.concurrency;
    (job as any).strategy = { matrix: '${{ fromJSON(vars.RUNNERS) }}' };
    const workflow = { on: { push: {} }, concurrency: group, jobs: { deploy: job } };
    expect(rules(check({ 'p.yml': workflow }))).toEqual([['stack', 'p.yml#deploy']]);
  });

  test('read-prior-job-only-dispatch: a read in a job that may skip does not count', () => {
    const lookup = {
      ...deploy([{ id: 'before', run: 'pebble-infra outputs staging --github-output --if-exists' }]),
      if: "github.event_name == 'workflow_dispatch'",
      outputs: { url: '${{ steps.before.outputs.database_url }}' },
    };
    const apply = { ...deploy(migrateFirst('staging', 'needs.lookup.outputs.url')), needs: 'lookup', if: 'always()' };
    expect(rules(check({ 'p.yml': { on: { push: {} }, jobs: { lookup, apply } } }))).toEqual([
      ['migrate', 'p.yml#apply'],
    ]);
  });

  test.each([
    ['spaced-secret-lookup', "${{ secrets [ 'MISSING_TOKEN' ] }}"],
    ['spaced-computed-secret-lookup', "${{ secrets [ format('MISSING_{0}', 'TOKEN') ] }}"],
  ])('%s: secrets other than secrets.NAME refuses', (_name, value) => {
    const job = deploy();
    job.steps[2]!.env.TOKEN = value;
    expect(check({ 'p.yml': { on: { push: {} }, jobs: { deploy: job } } })).toEqual([
      { rule: 'secrets', job: 'p.yml#deploy', message: expect.stringContaining('other than as secrets.NAME') },
    ]);
  });

  test('literal-symbolic-pr-overlap: a literal pr-<n> beside the PR form refuses', () => {
    const pr = (stack: string, name: string) => ({
      ...deploy(migrateFirst(stack)),
      environment: 'preview',
      concurrency: { group: name, 'cancel-in-progress': true },
      env: state('stg', 'preview', 'preview'),
    });
    const jobs = {
      fixed: pr('pr-1', 'preview-fixed'),
      each: pr('"pr-${{ github.event.pull_request.number }}"', 'preview-${{ github.event.pull_request.number }}'),
    };
    expect(rules(check({ 'p.yml': { on: { pull_request: {} }, jobs } }, { secrets: { preview: TABLE } }))).toEqual([
      ['stack', 'p.yml#fixed'],
    ]);
  });

  test('literal-role-lookalike: role-to-assume without ${{ }} is the literal text', () => {
    expect(
      one((job) => {
        job.steps[0] = { ...credentials, with: { ...credentials.with, 'role-to-assume': 'secrets.ROLE' } };
        job.steps.push({ env: { ROLE: '${{ secrets.ROLE }}' }, run: 'test -n "$ROLE"' });
      })
    ).toEqual([['state', 'p.yml#deploy']]);
  });

  test('literal-values-lookalike: PEBBLE_INFRA_VALUES without ${{ }} hands the CLI no values', () => {
    expect(one((job) => (job.steps[3]!.env = { PEBBLE_INFRA_VALUES: 'toJSON(secrets)' }))).toEqual([
      ['secrets', 'p.yml#deploy'],
      ['secrets', 'environment staging'],
    ]);
  });
});
