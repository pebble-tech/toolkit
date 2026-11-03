import { githubEnvironment } from '@pebbletech/infra';
import { checkWorkflows, loadWorkflow, runProgram, type WorkflowChecks } from '@pebbletech/infra/testing';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { bootstrap } from './bootstrap.js';
import * as entries from './entries.js';

const WORKFLOWS = join(import.meta.dirname, '../.github/workflows');
const FILES = ['preview.yml', 'deploy-staging.yml', 'deploy-production.yml'] as const;
type File = (typeof FILES)[number];

/** Every secret set in each of basefresh's GitHub environments. */
const SECRETS = {
  preview: ['AWS_DEPLOY_ROLE_ARN', 'PG_ADMIN_URL', 'CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_ACCOUNT_ID'],
  staging: [
    'AWS_DEPLOY_ROLE_ARN',
    'PG_ADMIN_URL',
    'DATABASE_RUNTIME_URL',
    'CLOUDFLARE_ZONE_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'BETTER_AUTH_SECRET',
    'ALARM_TOPIC_ARN',
    'VERCEL_API_TOKEN',
    'VERCEL_TEAM_ID',
  ],
  production: [
    'AWS_DEPLOY_ROLE_ARN',
    'PG_ADMIN_URL',
    'DATABASE_RUNTIME_URL',
    'CLOUDFLARE_ZONE_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'BETTER_AUTH_SECRET',
    'ALARM_TOPIC_ARN',
    'VERCEL_API_TOKEN',
    'VERCEL_TEAM_ID',
    'VERCEL_AUTOMATION_BYPASS_SECRET',
  ],
};

const checks = (
  workflows: string[] = FILES.map((file) => join(WORKFLOWS, file)),
  secrets: WorkflowChecks['secrets'] = SECRETS
): WorkflowChecks => ({
  workflows,
  product: 'basefresh',
  region: 'ap-southeast-1',
  entries,
  secrets,
  roleSecret: 'AWS_DEPLOY_ROLE_ARN',
  database: { output: 'database_url', stacks: ['preview', 'staging', 'prod'] },
  // entries.ts's derive reads the runtime role and its password from the pooled URL.
  derived: { PG_RUNTIME_ROLE: ['DATABASE_RUNTIME_URL'], PG_RUNTIME_PASSWORD: ['DATABASE_RUNTIME_URL'] },
});

/** The three workflows in a fresh directory, with `from` replaced by `to` in `file`: a broken copy of the fixture. */
function broken(file: File, from: string, to: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'basefresh-workflows-'));
  return FILES.map((name) => {
    let text = readFileSync(join(WORKFLOWS, name), 'utf8');
    if (name === file) {
      if (!text.includes(from)) throw new Error(`${file} has no ${JSON.stringify(from)}`);
      text = text.replace(from, to);
    }
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  });
}

const found = (workflows?: string[], secrets: WorkflowChecks['secrets'] = SECRETS) =>
  checkWorkflows(checks(workflows, secrets)).map(({ rule, job }) => [rule, job]);

describe('basefresh workflows', () => {
  test('pass every check', () => {
    expect(checkWorkflows(checks())).toEqual([]);
  });

  describe('fail, naming the job and the rule, when', () => {
    test('the job that clears prod’s lock leaves the group it shares with prod-preview', () => {
      const workflows = broken('deploy-production.yml', 'group: pulumi-prod', 'group: release-prod');
      expect(checkWorkflows(checks(workflows))).toEqual([
        {
          rule: 'lock',
          job: 'deploy-production.yml#deploy',
          message: expect.stringContaining('passes --clear-lock on prod in group release-prod'),
        },
      ]);
    });

    test('the job that clears prod’s lock may be cancelled in progress', () => {
      const workflows = broken(
        'deploy-production.yml',
        'group: pulumi-prod\n      cancel-in-progress: false',
        'group: pulumi-prod\n      cancel-in-progress: true'
      );
      expect(found(workflows)).toEqual([['lock', 'deploy-production.yml#deploy']]);
    });

    test('the close job, which runs remove on pr-<N>, holds no group', () => {
      const workflows = broken(
        'preview.yml',
        "    if: github.event.action == 'closed'\n    runs-on: ubuntu-latest\n    environment: preview\n    concurrency:\n      group: preview-${{ github.event.pull_request.number }}\n      cancel-in-progress: true\n",
        "    if: github.event.action == 'closed'\n    runs-on: ubuntu-latest\n    environment: preview\n"
      );
      expect(checkWorkflows(checks(workflows))).toEqual([
        {
          rule: 'lock',
          job: 'preview.yml#close',
          message: expect.stringContaining(
            'preview.yml#close runs on pr-${{ github.event.pull_request.number }} in group (none)'
          ),
        },
      ]);
    });

    test('a deploy runs up before it reads the database URL', () => {
      const workflows = broken(
        'deploy-production.yml',
        "      - name: Migrate prod\n        if: steps.before.outputs.database_url != ''\n        env:\n          DATABASE_URL: ${{ steps.before.outputs.database_url }}\n        run: pnpm db:migrate\n\n",
        ''
      );
      expect(checkWorkflows(checks(workflows))).toEqual([
        {
          rule: 'migrate',
          job: 'deploy-production.yml#deploy',
          message: expect.stringContaining("before any step in this job reads prod's database_url"),
        },
      ]);
    });

    test('a preview reads the database URL before it prepares the PR stack, which can reset it', () => {
      const workflows = broken(
        'preview.yml',
        '          pnpm --dir infra exec pebble-infra prepare "pr-${{ github.event.pull_request.number }}" --entries dist/entries.js --clear-lock\n',
        ''
      );
      expect(checkWorkflows(checks(workflows))).toEqual([
        {
          rule: 'migrate',
          job: 'preview.yml#deploy',
          message: expect.stringContaining('before any unconditional `pebble-infra prepare pr-'),
        },
      ]);
    });

    test('a job reads a secret its environment does not set', () => {
      const workflows = broken(
        'deploy-production.yml',
        "          SMOKE_READONLY: '1'\n",
        "          SMOKE_READONLY: '1'\n          SENTRY_DSN: ${{ secrets.SENTRY_DSN }}\n"
      );
      expect(checkWorkflows(checks(workflows))).toEqual([
        {
          rule: 'secrets',
          job: 'deploy-production.yml#smoke',
          message: expect.stringContaining('reads secrets.SENTRY_DSN, which environment production does not set'),
        },
      ]);
    });

    test('an up through PEBBLE_INFRA_VALUES needs an entry its environment does not set', () => {
      const staging = SECRETS.staging.filter((name) => name !== 'CLOUDFLARE_API_TOKEN');
      expect(checkWorkflows(checks(undefined, { ...SECRETS, staging }))).toEqual([
        {
          rule: 'secrets',
          job: 'deploy-staging.yml#deploy',
          message: expect.stringContaining(
            'runs `pebble-infra up staging --entries dist/entries.js --clear-lock`, which needs CLOUDFLARE_API_TOKEN; environment staging does not set it'
          ),
        },
      ]);
    });

    test('a value derive reads is missing, so the runtime role and password it gives are too', () => {
      const staging = SECRETS.staging.filter((name) => name !== 'DATABASE_RUNTIME_URL');
      expect(checkWorkflows(checks(undefined, { ...SECRETS, staging })).map((v) => [v.rule, v.message])).toEqual([
        ['secrets', expect.stringContaining('which needs PG_RUNTIME_ROLE, PG_RUNTIME_PASSWORD')],
      ]);
    });

    test('a preview of prod clears a lock', () => {
      const workflows = broken('deploy-staging.yml', '--summary', '--summary --clear-lock');
      expect(checkWorkflows(checks(workflows))).toEqual([
        {
          rule: 'lock',
          job: 'deploy-staging.yml#prod-preview',
          message: expect.stringContaining('a preview never clears a lock'),
        },
      ]);
    });

    test('prod’s first-release migration reads steps.up.outputs, which the pulumi action does not set', () => {
      const workflows = broken(
        'deploy-production.yml',
        '${{ fromJSON(steps.up.outputs.json).database_url }}',
        '${{ steps.up.outputs.database_url }}'
      );
      expect(checkWorkflows(checks(workflows))).toEqual([
        {
          rule: 'migrate',
          job: 'deploy-production.yml#deploy',
          message: expect.stringContaining('that reads fromJSON(steps.up.outputs.json).database_url'),
        },
      ]);
    });

    test('the pulumi action’s clear-lock is not a literal', () => {
      const workflows = broken(
        'deploy-production.yml',
        'clear-lock: true',
        'clear-lock: ${{ github.event.release.prerelease }}'
      );
      expect(found(workflows)).toEqual([['stack', 'deploy-production.yml#deploy']]);
    });

    test('prepare --preview-only clears a lock', () => {
      const workflows = broken(
        'deploy-staging.yml',
        'pebble-infra preview prod --entries dist/entries.js --summary',
        'pebble-infra prepare prod --preview-only --clear-lock'
      );
      expect(found(workflows)).toEqual([['lock', 'deploy-staging.yml#prod-preview']]);
    });
  });

  test('accept one PR group that cancels in progress, with up --clear-lock and remove --clear-lock on pr-<N>', () => {
    const preview = loadWorkflow(join(WORKFLOWS, 'preview.yml'));
    const group = { group: 'preview-${{ github.event.pull_request.number }}', 'cancel-in-progress': true };
    expect([
      preview.jobs.deploy!.concurrency,
      preview.jobs.close!.concurrency,
      preview.jobs.deploy!.steps.some(
        (step) =>
          step.run?.includes('pebble-infra up "pr-${{ github.event.pull_request.number }}"') &&
          step.run.includes('--clear-lock')
      ),
      preview.jobs.close!.steps.some(
        (step) =>
          step.run?.includes('pebble-infra remove "pr-${{ github.event.pull_request.number }}"') &&
          step.run.includes('--clear-lock')
      ),
    ]).toEqual([group, group, true, true]);
    expect(checkWorkflows(checks([join(WORKFLOWS, 'preview.yml')], { preview: SECRETS.preview }))).toEqual([]);
  });

  // base-app's workflows.test.ts, check by check.
  describe("base-app's checks", () => {
    test('a job on a stack runs in the environment its deploy role trusts', () => {
      const workflows = broken('deploy-staging.yml', 'environment: production', 'environment: staging');
      expect(found(workflows)).toEqual([['state', 'deploy-staging.yml#prod-preview']]);
    });

    test('a job assumes its environment’s deploy role secret and no other', () => {
      const workflows = broken(
        'deploy-production.yml',
        'role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}',
        'role-to-assume: ${{ secrets.PG_ADMIN_URL }}'
      );
      expect(found(workflows)).toEqual([['state', 'deploy-production.yml#deploy']]);
    });

    test('a job logs in to its own stack’s state and key', () => {
      const workflows = broken(
        'deploy-staging.yml',
        'PULUMI_BACKEND_URL: s3://pebble-stg-pulumi-state/basefresh/shared?region=ap-southeast-1',
        'PULUMI_BACKEND_URL: s3://pebble-stg-pulumi-state/basefresh/staging?region=ap-southeast-1'
      );
      expect(found(workflows)).toEqual([['state', 'deploy-staging.yml#deploy']]);
    });

    test('every job on prod queues its pending runs', () => {
      const workflows = broken(
        'deploy-staging.yml',
        'group: pulumi-prod\n      cancel-in-progress: false\n      queue: max',
        'group: pulumi-prod\n      cancel-in-progress: false'
      );
      expect(found(workflows)).toEqual([['concurrency', 'deploy-staging.yml#prod-preview']]);
    });

    test('a secret the table lists is read by some job', () => {
      expect(found(undefined, { ...SECRETS, staging: [...SECRETS.staging, 'PLUNK_SECRET_KEY'] })).toEqual([
        ['secrets', 'environment staging'],
      ]);
    });

    test('a release run holds one lock from deploy to smoke, so its smoke checks its own deploy', () => {
      const release = loadWorkflow(join(WORKFLOWS, 'deploy-production.yml'));
      expect([release.concurrency, release.jobs.smoke!.needs]).toEqual([
        { group: 'deploy-production', 'cancel-in-progress': false, queue: 'max' },
        ['deploy'],
      ]);
    });

    test.each(['preview', 'staging', 'prod'] as const)(
      '%s: the deploy role is named for its env and trusts the environment the checks expect',
      async (env) => {
        const { resources } = await runProgram({ project: 'basefresh-bootstrap', stack: env }, () => bootstrap(env));
        const role = resources.find((r) => r.type === 'aws:iam/role:Role')!;
        const subjects = JSON.parse(role.inputs.assumeRolePolicy).Statement[0].Condition.StringEquals[
          'token.actions.githubusercontent.com:sub'
        ];
        expect([role.inputs.name, subjects]).toEqual([
          `basefresh-${env}-deploy`,
          [`repo:pebble-tech/basefresh:environment:${githubEnvironment(env)}`],
        ]);
      }
    );
  });
});
