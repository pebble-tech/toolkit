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

/** Prepare a PR stack, read the URL, migrate when there is one, up, and migrate a first deploy from up's own output. */
const migrateFirst = (stack: string, read = 'steps.before.outputs.database_url') => [
  ...(stack.replace(/^"/, '').startsWith('pr-')
    ? [
        {
          env: VALUES,
          run: `pnpm --dir infra exec pebble-infra prepare ${stack} --entries dist/entries.js --clear-lock`,
        },
      ]
    : []),
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

  test('pulumi run directly after a global flag fails the same way; login after one passes', () => {
    const raw = {
      on: { push: {} },
      jobs: {
        deploy: {
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              run: [
                'pulumi --non-interactive login "$PULUMI_BACKEND_URL"',
                'pulumi -C infra login s3://acme-state/acme/staging',
                'pulumi -s staging up --yes',
                'pulumi --cwd infra destroy --yes',
                'pulumi --cwd=infra --non-interactive preview',
                'pulumi -C infra cancel',
              ].join('\n'),
            },
          ],
        },
      },
    };
    expect(
      check({ 'raw.yml': raw }, { secrets: {} }).map((v) => /runs `pulumi (\S+)` directly/.exec(v.message)?.[1])
    ).toEqual(['up', 'destroy', 'preview', 'cancel']);
  });

  test('a pulumi/actions step in a job holding state credentials fails, by name; without them it is not read', () => {
    const job = (steps: object[]) => ({
      on: { push: {} },
      jobs: { deploy: { 'runs-on': 'ubuntu-latest', steps } },
    });
    const action = {
      name: 'Deploy',
      uses: 'pulumi/actions@v6',
      with: { command: 'up', 'stack-name': 'prod', 'work-dir': 'infra' },
    };
    expect([
      check({ 'a.yml': job([credentials, action]) }, { secrets: {} }),
      check({ 'b.yml': job([action]) }, { secrets: {} }),
    ]).toEqual([
      [
        {
          rule: 'stack',
          job: 'a.yml#deploy',
          message: expect.stringContaining('step "Deploy" runs pulumi/actions@v6 in a job holding state credentials'),
        },
      ],
      [],
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

  // On a pr-<n> stack, prepare resets a stack an interrupted run left and drops its database: a URL read before it can
  // name the database about to be dropped, and its non-empty value keeps the first-deploy migration from running.
  describe('a PR stack prepares before it reads', () => {
    const job = (steps: object[]) => ({
      on: { pull_request: {} },
      jobs: {
        deploy: {
          'runs-on': 'ubuntu-latest',
          environment: 'preview',
          concurrency: { group: 'preview-1', 'cancel-in-progress': true },
          env: state('stg', 'preview', 'preview'),
          steps: [credentials, ...steps],
        },
      },
    });
    const [prepare, before, ...rest] = migrateFirst('pr-1') as Record<string, any>[];
    const run = (steps: object[]) => check({ 'p.yml': job(steps) }, { secrets: { preview: TABLE } });

    test("prepare, then the read, passes; so does a prepare earlier inside the read's step", () => {
      expect([
        run([prepare, before, ...rest]),
        run([{ ...before, env: VALUES, run: `${prepare.run}\n${before.run}` }, ...rest]),
      ]).toEqual([[], []]);
    });

    test('the read before prepare fails, naming the job', () => {
      expect(run([before, prepare, ...rest])).toEqual([
        {
          rule: 'migrate',
          job: 'p.yml#deploy',
          message: expect.stringContaining(
            "reads pr-1's database_url (step #2) before any unconditional `pebble-infra prepare pr-1` in this job"
          ),
        },
      ]);
    });

    test.each([
      ['no prepare', [before]],
      ['a prepare --preview-only', [{ run: 'pebble-infra prepare pr-1 --preview-only' }, before]],
      ['a prepare under if:', [{ ...prepare, if: "github.event.action == 'opened'" }, before]],
      ["a prepare later inside the read's step", [{ ...before, env: VALUES, run: `${before.run}\n${prepare.run}` }]],
    ] as [string, object[]][])('%s before the read fails', (_name, steps) => {
      expect(rules(run([...steps, ...rest]))).toEqual([['migrate', 'p.yml#deploy']]);
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

// The toolkit's pulumi action, read as the pebble-infra command its literal inputs make; every rule then applies as to
// a run: line.
describe('the pulumi action', () => {
  const ACTION = `pebble-tech/toolkit/.github/actions/pulumi@${'0'.repeat(40)}`;
  const group = { group: 'pulumi-staging', 'cancel-in-progress': false, queue: 'max' };
  const wrapped = (inputs: Record<string, unknown>, uses = ACTION) => ({
    id: 'up',
    uses,
    env: VALUES,
    with: { command: 'up', stack: 'staging', entries: 'dist/entries.js', 'clear-lock': true, ...inputs },
  });
  const [before, migrate, , first] = migrateFirst('staging') as Record<string, any>[];
  const fromJson = { ...first, env: { DATABASE_URL: '${{ fromJSON(steps.up.outputs.json).database_url }}' } };
  const job = (steps: object[], extra: object = {}) => ({
    'runs-on': 'ubuntu-latest',
    environment: 'staging',
    concurrency: group,
    env: state('stg', 'staging', 'staging'),
    steps: [credentials, ...steps],
    ...extra,
  });
  const reader = (step: object, extra: object = {}) =>
    job([step], { needs: 'deploy', ...extra }) as ReturnType<typeof job>;
  const run = (jobs: Record<string, object>) => rules(check({ 'p.yml': { on: { push: {} }, jobs } }));

  test('an up through the action, migrating first and reading its output from the JSON, passes', () => {
    expect(run({ deploy: job([before, migrate, wrapped({}), fromJson]) })).toEqual([]);
  });

  test.each([
    ['an up without the migrate-first read', { deploy: job([wrapped({}), fromJson]) }, [['migrate', 'p.yml#deploy']]],
    [
      'an up whose first-deploy migration reads steps.up.outputs, which the action does not set',
      { deploy: job([before, migrate, wrapped({}), first]) },
      [['migrate', 'p.yml#deploy']],
    ],
    [
      'a preview with clear-lock: true',
      {
        deploy: job([before, migrate, wrapped({}), fromJson]),
        preview: reader(wrapped({ command: 'preview', 'clear-lock': true })),
      },
      [['lock', 'p.yml#preview']],
    ],
    [
      'an up clearing staging’s lock outside the group the other job on staging holds',
      {
        deploy: job([before, migrate, wrapped({}), fromJson], { concurrency: { ...group, group: 'release-staging' } }),
        preview: reader({ env: VALUES, run: 'pebble-infra preview staging --entries e.js' }),
      },
      [['lock', 'p.yml#deploy']],
    ],
    [
      'a stack input that is not a literal',
      { deploy: job([before, migrate, wrapped({ stack: '${{ inputs.stack }}' }), fromJson]) },
      [['stack', 'p.yml#deploy']],
    ],
    [
      'a clear-lock input that is not a literal',
      { deploy: job([before, migrate, wrapped({ 'clear-lock': "${{ github.event_name == 'push' }}" }), fromJson]) },
      [['stack', 'p.yml#deploy']],
    ],
    [
      'a command input that is not up, preview or remove',
      { deploy: job([before, migrate, wrapped({ command: 'destroy' }), fromJson]) },
      [['stack', 'p.yml#deploy']],
    ],
    [
      'an input the action does not take',
      { deploy: job([before, migrate, wrapped({ 'preview-only': true }), fromJson]) },
      [['stack', 'p.yml#deploy']],
    ],
    [
      'another path in the toolkit repo',
      { deploy: job([before, migrate, wrapped({}, ACTION.replace('/pulumi@', '/pulumi/@')), fromJson]) },
      [['stack', 'p.yml#deploy']],
    ],
    [
      'the owner and repo in another case, which GitHub runs as the same action',
      { deploy: job([wrapped({}, ACTION.replace('pebble-tech/toolkit', 'Pebble-Tech/Toolkit')), fromJson]) },
      [['migrate', 'p.yml#deploy']],
    ],
  ] as [string, Record<string, object>, string[][]][])('%s fails', (_name, jobs, expected) => {
    expect(run(jobs)).toEqual(expected);
  });

  test.each([
    ['a literal infra directory', { infra: 'apps/infra' }],
    ['a literal entries path with a space', { entries: 'dist/my entries.js' }],
    ['a ref with a slash', {}, ACTION.replace(/@.*/, '@release/v1')],
  ] as [string, Record<string, unknown>, string?][])('%s passes', (_name, inputs, uses) => {
    expect(run({ deploy: job([before, migrate, wrapped(inputs, uses), fromJson]) })).toEqual([]);
  });

  const { entries: _entries, ...noEntries } = wrapped({}).with;
  test.each([
    ['no entries input', { deploy: job([before, migrate, { ...wrapped({}), with: noEntries }, fromJson]) }],
    [
      'an entries input that is not a literal',
      { deploy: job([before, migrate, wrapped({ entries: '${{ inputs.entries }}' }), fromJson]) },
    ],
    [
      'an infra input that is not a literal',
      { deploy: job([before, migrate, wrapped({ infra: '${{ inputs.infra }}' }), fromJson]) },
    ],
    [
      'the action path in another case',
      { deploy: job([before, migrate, wrapped({}, ACTION.replace('/pulumi@', '/Pulumi@')), fromJson]) },
    ],
  ] as [string, Record<string, object>][])('%s refuses', (_name, jobs) => {
    expect(run(jobs)).toEqual([['stack', 'p.yml#deploy']]);
  });

  test('a ref with a slash is still read: an up without the read fails', () => {
    expect(run({ deploy: job([wrapped({}, ACTION.replace(/@.*/, '@release/v1')), fromJson]) })).toEqual([
      ['migrate', 'p.yml#deploy'],
    ]);
  });

  test('a refusal names the step and what the helper reads', () => {
    const jobs = { deploy: job([before, migrate, wrapped({ stack: '${{ inputs.stack }}' }), fromJson]) };
    expect(check({ 'p.yml': { on: { push: {} }, jobs } })).toEqual([
      {
        rule: 'stack',
        job: 'p.yml#deploy',
        message: expect.stringContaining(
          'step #4 runs `pebble-infra up ${{ inputs.stack }} --entries dist/entries.js --clear-lock` and its stack is not shared'
        ),
      },
    ]);
  });
});

// Migrate first, for both forms of up: up itself runs unconditionally, and a read of an output counts only inside
// `${{ }}`, outside a quoted string.
describe('migrate first reads only what runs', () => {
  const ACTION = `pebble-tech/toolkit/.github/actions/pulumi@${'0'.repeat(40)}`;
  const group = { group: 'pulumi-staging', 'cancel-in-progress': false, queue: 'max' };
  const [before, migrate, up, first] = migrateFirst('staging') as Record<string, any>[];
  const wrappedUp = {
    id: 'up',
    uses: ACTION,
    env: VALUES,
    with: { command: 'up', stack: 'staging', entries: 'dist/entries.js', 'clear-lock': true },
  };
  const firstFrom = (value: string) => ({ ...first, env: { DATABASE_URL: value } });
  const run = (steps: object[]) =>
    rules(
      check({
        'p.yml': {
          on: { push: {} },
          jobs: {
            deploy: {
              'runs-on': 'ubuntu-latest',
              environment: 'staging',
              concurrency: group,
              env: state('stg', 'staging', 'staging'),
              steps: [credentials, ...steps],
            },
          },
        },
      })
    );
  const RUN_READ = 'steps.up.outputs.database_url';
  const JSON_READ = 'fromJSON(steps.up.outputs.json).database_url';

  test.each([
    ['run', up, RUN_READ],
    ['pulumi action', wrappedUp, JSON_READ],
  ] as [string, object, string][])('%s form: the read as an expression passes', (_form, upStep, read) => {
    expect(run([before, migrate, upStep, firstFrom(`\${{ ${read} }}`)])).toEqual([]);
  });

  test.each([
    ['run', up, RUN_READ],
    ['pulumi action', wrappedUp, JSON_READ],
  ] as [string, object, string][])('%s form: an up under if: false fails', (_form, upStep, read) => {
    expect(run([before, migrate, { ...upStep, if: 'false' }, firstFrom(`\${{ ${read} }}`)])).toEqual([
      ['migrate', 'p.yml#deploy'],
    ]);
  });

  test.each([
    ['run, plain text', up, RUN_READ],
    ['run, a quoted string', up, `\${{ '${RUN_READ}' }}`],
    ['pulumi action, plain text', wrappedUp, JSON_READ],
    ['pulumi action, a quoted string', wrappedUp, `\${{ '${JSON_READ}' }}`],
  ] as [string, object, string][])(
    '%s form: a first-deploy read that is not an expression fails',
    (_form, upStep, value) => {
      expect(run([before, migrate, upStep, firstFrom(value)])).toEqual([['migrate', 'p.yml#deploy']]);
    }
  );
});
