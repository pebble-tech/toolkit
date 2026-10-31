import { checkWorkflows, type WorkflowChecks } from '@pebbletech/infra/testing';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import * as entries from './entries.js';

const WORKFLOW = join(import.meta.dirname, '../.github/workflows/deploy-production.yml');
const README = join(import.meta.dirname, '../../../packages/infra/README.md');

/** Every secret set in the product's production GitHub environment. */
const SECRETS = {
  production: [
    'AWS_DEPLOY_ROLE_ARN',
    'PG_ADMIN_URL',
    'PG_RUNTIME_ROLE',
    'PG_RUNTIME_PASSWORD',
    'CLOUDFLARE_ZONE_ID',
    'CLOUDFLARE_API_TOKEN',
    'VERCEL_API_TOKEN',
    'VERCEL_TEAM_ID',
  ],
};

const checks = (workflow = WORKFLOW, secrets: WorkflowChecks['secrets'] = SECRETS): WorkflowChecks => ({
  workflows: [workflow],
  product: 'notes',
  region: 'ap-southeast-1',
  entries,
  secrets,
  roleSecret: 'AWS_DEPLOY_ROLE_ARN',
  database: { output: 'database_url', stacks: ['preview', 'staging', 'prod'] },
});

/** The workflow in a fresh directory with `from` replaced by `to`: a broken copy. */
function broken(from: string, to: string): string {
  const text = readFileSync(WORKFLOW, 'utf8');
  if (!text.includes(from)) throw new Error(`the workflow has no ${JSON.stringify(from)}`);
  const file = join(mkdtempSync(join(tmpdir(), 'web-only-workflow-')), 'deploy-production.yml');
  writeFileSync(file, text.replace(from, to));
  return file;
}

describe('the web-only deploy-production.yml', () => {
  test('passes every check', () => {
    expect(checkWorkflows(checks())).toEqual([]);
  });

  test('is the one the package README shows, character for character', () => {
    const readme = readFileSync(README, 'utf8');
    const marker = '<!-- examples/web-only/.github/workflows/deploy-production.yml -->\n```yaml\n';
    const start = readme.indexOf(marker) + marker.length;
    expect(readme.slice(start, readme.indexOf('```\n', start))).toEqual(readFileSync(WORKFLOW, 'utf8'));
  });

  describe('fails, naming the job and the rule, when', () => {
    test('up runs before prod’s database is migrated', () => {
      const workflow = broken(
        "        if: steps.before.outputs.database_url != ''\n",
        '        if: github.event.release.prerelease\n'
      );
      expect(checkWorkflows(checks(workflow)).map(({ rule, job }) => [rule, job])).toEqual([
        ['migrate', 'deploy-production.yml#deploy'],
      ]);
    });

    test('production does not set a value up needs', () => {
      const production = SECRETS.production.filter((name) => name !== 'CLOUDFLARE_API_TOKEN');
      expect(checkWorkflows(checks(WORKFLOW, { production })).map(({ rule, job }) => [rule, job])).toEqual([
        ['secrets', 'deploy-production.yml#deploy'],
      ]);
    });
  });
});
