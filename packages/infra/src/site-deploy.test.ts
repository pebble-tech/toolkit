import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

/**
 * The shared site workflows (.github/workflows/site-build.yml, site-deploy.yml), their copyable stubs, and the script
 * site-deploy runs (.github/site-deploy/site-deploy.mjs), run the way the workflow runs it: a Node process reading
 * the event file, its env and the GitHub API, here a local server standing in for api.github.com.
 */
const ROOT = join(import.meta.dirname, '../../..');
const SCRIPT = join(ROOT, '.github/site-deploy/site-deploy.mjs');
const WORKFLOWS = {
  build: join(ROOT, '.github/workflows/site-build.yml'),
  deploy: join(ROOT, '.github/workflows/site-deploy.yml'),
  buildStub: join(ROOT, '.github/site-deploy/stubs/site-build.yml'),
  deployStub: join(ROOT, '.github/site-deploy/stubs/site-deploy.yml'),
};

type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  concurrency?: { group: string };
  steps?: Step[];
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, string>;
};
type Workflow = { name: string; on: any; permissions?: unknown; jobs: Record<string, Job> };

const load = (path: string): Workflow => parse(readFileSync(path, 'utf8'));
const clone = <T>(value: T): T => structuredClone(value);

/** A step by its id, or by the start of its name. */
const step = (job: Job | undefined, key: string): Step | undefined =>
  job?.steps?.find((s) => s.id === key || s.name?.startsWith(key));

const PIN = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const FORBIDDEN = [/--prod\b/, /\bpromote\b/, /production/, /\bvercel\s+(?:link|pull)\b/, /--scope\b/, /--target\b/];
const DECIDED = "steps.decide.outputs.deploy == 'true'";
const TOKEN = '${{ secrets.VERCEL_TOKEN }}';

/** What the toolkit's own reusable workflows must hold; each entry names the job and the rule it breaks. */
function violations(build: Workflow, deploy: Workflow): string[] {
  const found: string[] = [];
  for (const [file, workflow] of [
    ['site-build', build],
    ['site-deploy', deploy],
  ] as const) {
    if (!workflow.on?.workflow_call) found.push(`${file}: not on workflow_call`);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const where = `${file}#${id}`;
      if (!job.permissions) found.push(`${where}: no job permissions`);
      if (!job.concurrency && file === 'site-deploy') found.push(`${where}: no concurrency`);
      for (const s of job.steps ?? []) {
        if (s.uses?.startsWith('./')) found.push(`${where}: uses ${s.uses}, which a reusable workflow cannot`);
        if (s.uses && !PIN.test(s.uses)) found.push(`${where}: ${s.uses} is not pinned by sha`);
        if (s.run?.includes('${{')) found.push(`${where}: an expression in run (${s.name})`);
      }
    }
  }
  const buildJob = build.jobs.build!;
  const buildPermissions = [build.permissions, ...Object.values(build.jobs).map((job) => job.permissions)];
  if (!buildPermissions.every((p) => JSON.stringify(p) === '{"contents":"read"}')) {
    found.push('site-build: permissions other than contents: read');
  }
  if (JSON.stringify(build).includes('secrets.') || build.on.workflow_call.secrets) {
    found.push('site-build: reads a secret');
  }
  const setup = buildJob.steps?.find((s) => s.uses?.startsWith('pebble-tech/toolkit/.github/actions/setup@'));
  if (setup?.with?.pulumi !== false) found.push('site-build: the setup action is not used with pulumi: false');

  if (JSON.stringify(deploy.permissions) !== '{}') found.push('site-deploy: top-level permissions are not {}');
  // F1: the token is an environment secret, VERCEL_TOKEN, optional at the call and checked inside the job.
  const secrets = deploy.on.workflow_call.secrets ?? {};
  if (
    JSON.stringify(Object.keys(secrets).sort()) !== '["RUNTIME_ENV","VERCEL_TOKEN"]' ||
    secrets.VERCEL_TOKEN?.required
  ) {
    found.push('site-deploy: the secrets are not an optional VERCEL_TOKEN and RUNTIME_ENV');
  }
  // What the jobs run and pass, not the inputs' descriptions (which name production to refuse it).
  const text = Object.values(deploy.jobs)
    .flatMap((job) => (job.steps ?? []).flatMap((s) => [s.run, ...Object.values({ ...s.env, ...s.with })]))
    .join('\n');
  for (const pattern of FORBIDDEN) if (pattern.test(text)) found.push(`site-deploy: matches ${pattern}`);
  for (const [id, event, permissions] of [
    ['preview', 'pull_request', { actions: 'read', contents: 'read', 'pull-requests': 'write' }],
    ['staging', 'push', { actions: 'read', contents: 'read' }],
  ] as const) {
    const job = deploy.jobs[id];
    const where = `site-deploy#${id}`;
    if (!job) {
      found.push(`${where}: missing`);
      continue;
    }
    // D5: the job-level if is exactly these clauses, and-ed: no `||`, no `!`, nothing compared to anything else.
    const clauses = (job.if ?? '').split('&&').map((clause) => clause.replace(/\s+/g, ' ').trim());
    const expected = [
      "github.event_name == 'workflow_run'",
      `github.event.workflow_run.event == '${event}'`,
      "github.event.workflow_run.conclusion == 'success'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ];
    if (JSON.stringify(clauses.sort()) !== JSON.stringify([...expected].sort())) {
      found.push(`${where}: its job-level if is not exactly ${expected.join(' && ')}`);
    }
    if (job.environment !== `\${{ inputs.${id}-environment }}`) {
      found.push(`${where}: its environment is ${job.environment}, not its own input ${id}-environment`);
    }
    if (JSON.stringify(job.permissions) !== JSON.stringify(permissions)) {
      found.push(`${where}: permissions ${JSON.stringify(job.permissions)}`);
    }
    const steps = job.steps ?? [];
    const index = (key: string) => steps.findIndex((s) => s.id === key || s.name?.startsWith(key));
    // F9: the toolkit ref is checked before it is checked out; the CLI is installed before the artifact arrives.
    if (!step(job, 'The toolkit ref')?.run?.includes('[[ ! "$TOOLKIT_REF" =~ ^[0-9a-f]{40}$ ]]')) {
      found.push(`${where}: toolkit-ref is not checked against ^[0-9a-f]{40}$`);
    }
    for (const name of ['PREVIEW_ENVIRONMENT', 'STAGING_ENVIRONMENT']) {
      const input = `\${{ inputs.${name.split('_')[0]!.toLowerCase()}-environment }}`;
      if (step(job, 'decide')?.env?.[name] !== input) found.push(`${where}: decide does not get ${name}`);
    }
    if (!(index('The toolkit ref is a full commit sha') >= 0 && index('The toolkit ref') < index('Check out'))) {
      found.push(`${where}: toolkit-ref is not checked before the checkout`);
    }
    if (!(index('Install the locked') >= 0 && index('Install the locked') < index('Download'))) {
      found.push(`${where}: the CLI is not installed before the download`);
    }
    // D4: every step after decide runs only on its decision, directly or through a step that does.
    // Each such step's if is and-ed conditions, one of them the decision or a gated step's output: no `||`.
    const gated = new Set(['decide']);
    for (const s of steps.slice(index('decide') + 1)) {
      const condition = (s.if ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      const conjuncts = condition.split('&&').map((c) => c.trim());
      const gate = (c: string) =>
        c === DECIDED || [...gated].some((g) => new RegExp(`^steps\\.${g}\\.outputs\\.[\\w-]+ [!=]= '[^']*'$`).test(c));
      const on = !condition.includes('||') && conjuncts.some(gate);
      if (!on) found.push(`${where}: "${s.name}" runs whatever decide decided`);
      else if (s.id) gated.add(s.id);
    }
    const download = step(job, 'Download');
    if (
      download?.env?.RUN_ID !== '${{ steps.decide.outputs.run-id }}' ||
      !download.run?.includes('gh run download "$RUN_ID"')
    ) {
      found.push(`${where}: the download is not by the decided run id`);
    }
    // The project's root directory is main's input, handed to prepare through the environment, never the artifact's.
    const prepare = step(job, 'Prepare');
    if (
      prepare?.env?.ROOT_DIRECTORY !== '${{ inputs.working-directory }}' ||
      !prepare.run?.endsWith('site-deploy.mjs" prepare "$RUNNER_TEMP/artifact" "$RUNNER_TEMP/deploy" "$ROOT_DIRECTORY"')
    ) {
      found.push(`${where}: prepare does not get main's working-directory through ROOT_DIRECTORY`);
    }
    const token = step(job, 'The Vercel token is set');
    const tokenTest = /^\s*if \[ -z "\$VERCEL_TOKEN" \]; then\n[^\n]*\n\s*exit 1\n\s*fi\s*$/m;
    if (!tokenTest.test(token?.run ?? '') || token?.if !== DECIDED) {
      found.push(`${where}: the token check does not fail on an empty VERCEL_TOKEN`);
    }
    if (!(token && index('The Vercel token is set') < index('deploy') && token.env?.VERCEL_TOKEN === TOKEN)) {
      found.push(`${where}: no check that the environment holds VERCEL_TOKEN before the deploy`);
    }
    for (const s of steps) {
      if (s.uses?.startsWith('actions/checkout@') && s.with?.repository !== 'pebble-tech/toolkit') {
        found.push(`${where}: checks out something other than the toolkit`);
      }
      const vercel = s.run?.includes('/vercel/node_modules/.bin/vercel') && !s.run.includes('--version');
      if (vercel && (s as any)['working-directory'] !== '${{ runner.temp }}/deploy') {
        found.push(`${where}: runs vercel outside the prepared directory (${s.name})`);
      }
      if (vercel && (s.env?.GITHUB_TOKEN || (job as any).env?.GITHUB_TOKEN)) {
        found.push(`${where}: the GitHub token reaches the Vercel CLI (${s.name})`);
      }
      if (vercel && s.env?.VERCEL_TOKEN !== TOKEN)
        found.push(`${where}: the Vercel token is not VERCEL_TOKEN (${s.name})`);
      if (vercel && s.env?.VERCEL_PROJECT_ID !== '${{ inputs.vercel-project-id }}') {
        found.push(`${where}: the project id is not main's input (${s.name})`);
      }
      if (vercel && s.env?.VERCEL_ORG_ID !== '${{ inputs.vercel-team-id }}') {
        found.push(`${where}: the team id is not main's input (${s.name})`);
      }
      if (s.run?.includes('npm ci') && !s.run.includes('--ignore-scripts')) {
        found.push(`${where}: installs with scripts on`);
      }
      if (/\b(pnpm|npm (?:install|run|exec)|npx|yarn)\b/.test(s.run ?? '')) found.push(`${where}: runs ${s.run}`);
    }
    const deploys = steps.filter((s) => / deploy --prebuilt /.test(s.run ?? ''));
    const target = id === 'preview' ? '--environment=preview ' : '--environment="$VERCEL_ENVIRONMENT" ';
    if (deploys.length !== 1 || !deploys[0]!.run!.includes(target)) {
      found.push(`${where}: does not deploy with ${target}`);
    }
    // F5: the URL is the CLI's last line, validated by the script, never the raw output.
    if (!deploys[0]?.run?.includes('site-deploy.mjs" deployment-url'))
      found.push(`${where}: the deployment URL is not validated`);
  }
  // F6: staging deploys only on a tip check made right before it.
  const staging = deploy.jobs.staging;
  const stagingSteps = staging?.steps ?? [];
  const tipAt = stagingSteps.findIndex((s) => s.id === 'tip');
  if (
    !stagingSteps[tipAt]?.run?.endsWith('site-deploy.mjs" tip') ||
    stagingSteps[tipAt + 1]?.id !== 'deploy' ||
    step(staging, 'deploy')?.if !== "steps.tip.outputs.current == 'true'"
  ) {
    found.push('site-deploy#staging: the deploy is not gated by a tip check right before it');
  }
  const aliases = stagingSteps.filter((s) => s.run?.includes('alias'));
  if (aliases.length) found.push('site-deploy#staging: sets an alias');
  // A8: the alias and the comment each run only on a recheck of the PR made right before them.
  const preview = deploy.jobs.preview;
  for (const [gate, gated] of [
    ['before-alias', ['alias', 'Alias the preview']],
    ['before-comment', ['Comment the preview URL']],
  ] as const) {
    if (!step(preview, gate)?.run?.endsWith('site-deploy.mjs" recheck'))
      found.push(`site-deploy#preview: ${gate} is not a recheck`);
    for (const key of gated) {
      if (!step(preview, key)?.if?.includes(`steps.${gate}.outputs.current == 'true'`)) {
        found.push(`site-deploy#preview: "${key}" is not gated by ${gate}`);
      }
    }
  }
  // A stale staging build never cancels the tip's run, nor replaces its pending one; previews still cancel.
  if (
    JSON.stringify(staging?.concurrency) !==
    JSON.stringify({
      group: 'site-deploy-${{ inputs.artifact-name }}-staging',
      'cancel-in-progress': false,
      queue: 'max',
    })
  ) {
    found.push('site-deploy#staging: its concurrency cancels or drops runs');
  }
  if ((preview?.concurrency as any)?.['cancel-in-progress'] !== true)
    found.push('site-deploy#preview: a newer push does not cancel');
  // A failed alias still leaves the PR its deployment URL, with no alias in it.
  for (const key of ['before-comment', 'Comment the preview URL']) {
    if (!step(preview, key)?.if?.startsWith('${{ !cancelled() && '))
      found.push(`site-deploy#preview: "${key}" is skipped after a failed alias`);
  }
  if (
    step(preview, 'Comment the preview URL')?.env?.ALIAS !==
    "${{ steps.alias-set.outcome == 'success' && steps.alias.outputs.alias || '' }}"
  ) {
    found.push('site-deploy#preview: the comment names an alias that was not set');
  }
  const comment = step(preview, 'Comment the preview URL');
  if (comment?.env?.PR !== '${{ steps.decide.outputs.pr }}') {
    found.push('site-deploy#preview: the comment PR is not the verified one');
  }
  return found;
}

describe('the site workflows', () => {
  const build = load(WORKFLOWS.build);
  const deploy = load(WORKFLOWS.deploy);
  const p = (d: Workflow, key: string) => step(d.jobs.preview, key)!;
  const st = (d: Workflow, key: string) => step(d.jobs.staging, key)!;

  test('hold every rule', () => {
    expect(violations(build, deploy)).toEqual([]);
  });

  test.each<[string, (b: Workflow, d: Workflow) => void, string]>([
    ['an unpinned action', (b) => (b.jobs.build!.steps![0]!.uses = 'actions/checkout@v6'), 'is not pinned by sha'],
    [
      'a local action',
      (b) => (b.jobs.build!.steps![1]!.uses = './.github/actions/setup'),
      'which a reusable workflow cannot',
    ],
    [
      'a secret in the build',
      (b) => (b.jobs.build!.steps![2]!.env!.T = '${{ secrets.X }}'),
      'site-build: reads a secret',
    ],
    [
      'write access in the build',
      (b) => (b.jobs.build!.permissions = { contents: 'write' }),
      'other than contents: read',
    ],
    [
      'a job without permissions',
      (_b, d) => delete d.jobs.staging!.permissions,
      'site-deploy#staging: no job permissions',
    ],
    [
      'no fork check',
      (_b, d) => (d.jobs.preview!.if = "github.event.workflow_run.event == 'pull_request'"),
      'is not exactly',
    ],
    [
      'a fork check against another field',
      (_b, d) =>
        (d.jobs.preview!.if = d.jobs.preview!.if!.replace(
          'head_repository.full_name == github.repository',
          'head_repository.full_name == github.event.workflow_run.head_branch'
        )),
      'site-deploy#preview: its job-level if is not exactly',
    ],
    [
      'a fork check or-ed away',
      (_b, d) => (d.jobs.staging!.if += " || github.event.workflow_run.event == 'push'"),
      'site-deploy#staging: its job-level if is not exactly',
    ],
    ['a production deploy', (_b, d) => (st(d, 'deploy').run += ' --prod'), 'matches /--prod\\b/'],
    ['a promote', (_b, d) => (st(d, 'deploy').run = 'vercel promote x'), 'matches /\\bpromote\\b/'],
    ['vercel link', (_b, d) => (p(d, 'deploy').run += '\nvercel link --yes'), 'vercel'],
    [
      'an expression in run',
      (_b, d) => (p(d, 'decide').run = 'echo ${{ github.event.workflow_run.head_branch }}'),
      'an expression in run',
    ],
    ['a checkout of the product', (_b, d) => (p(d, 'Check out').with = {}), 'other than the toolkit'],
    ['scripts on', (_b, d) => (p(d, 'Install the locked').run = 'npm ci --prefix x'), 'installs with scripts on'],
    ['an artifact project id', (_b, d) => (p(d, 'deploy').env!.VERCEL_PROJECT_ID = 'x'), 'not main'],
    ['an install from the artifact', (_b, d) => (p(d, 'Prepare').run += '\npnpm install'), 'runs'],
    [
      'the PR number from elsewhere',
      (_b, d) => (p(d, 'Comment the preview URL').env!.PR = '${{ env.PR }}'),
      'not the verified',
    ],
    [
      'the GitHub token in the job env',
      (_b, d) => ((d.jobs.preview as any).env.GITHUB_TOKEN = '${{ github.token }}'),
      'reaches the Vercel CLI',
    ],
    ['no concurrency', (_b, d) => delete d.jobs.preview!.concurrency, 'site-deploy#preview: no concurrency'],
    [
      'an || true bypass of the decision',
      (_b, d) => (p(d, 'Download').if = "steps.decide.outputs.deploy == 'true' || true"),
      'site-deploy#preview: "Download the artifact by the triggering run id" runs whatever decide decided',
    ],
    [
      'a staging group that cancels',
      (_b, d) => ((d.jobs.staging!.concurrency as any)['cancel-in-progress'] = true),
      'site-deploy#staging: its concurrency cancels or drops runs',
    ],
    [
      'a staging group that drops pending runs',
      (_b, d) => delete (d.jobs.staging!.concurrency as any).queue,
      'site-deploy#staging: its concurrency cancels or drops runs',
    ],
    [
      'a comment skipped after a failed alias',
      (_b, d) => (p(d, 'before-comment').if = "steps.deploy.outputs.url != ''"),
      '"before-comment" is skipped after a failed alias',
    ],
    [
      'a comment naming an alias that failed',
      (_b, d) => (p(d, 'Comment the preview URL').env!.ALIAS = '${{ steps.alias.outputs.alias }}'),
      'the comment names an alias that was not set',
    ],
    // R2-1
    [
      "the preview job in staging's environment",
      (_b, d) => (d.jobs.preview!.environment = '${{ inputs.staging-environment }}'),
      'site-deploy#preview: its environment is ${{ inputs.staging-environment }}, not its own input preview-environment',
    ],
    [
      'the staging job in a literal environment',
      (_b, d) => (d.jobs.staging!.environment = 'staging'),
      'site-deploy#staging: its environment is staging',
    ],
    [
      'no token check in the preview job',
      (_b, d) =>
        (d.jobs.preview!.steps = d.jobs.preview!.steps!.filter((s) => !s.name?.startsWith('The Vercel token'))),
      'site-deploy#preview: no check that the environment holds VERCEL_TOKEN',
    ],
    [
      'a looser toolkit-ref check in staging',
      (_b, d) => (st(d, 'The toolkit ref').run = st(d, 'The toolkit ref').run!.replace('{40}', '+')),
      'site-deploy#staging: toolkit-ref is not checked against',
    ],
    [
      'a looser toolkit-ref check in preview',
      (_b, d) => (p(d, 'The toolkit ref').run = p(d, 'The toolkit ref').run!.replace('^[0-9a-f]', '^[0-9a-z]')),
      'site-deploy#preview: toolkit-ref is not checked against',
    ],
    ...(['preview', 'staging'] as const).map(
      (id) =>
        [
          `a token check that never fails (${id})`,
          (_b: Workflow, d: Workflow) => {
            const check = step(d.jobs[id], 'The Vercel token is set')!;
            check.run = check.run!.replace('if [ -z "$VERCEL_TOKEN" ]; then', 'if false; then');
          },
          `site-deploy#${id}: the token check does not fail on an empty VERCEL_TOKEN`,
        ] as [string, (b: Workflow, d: Workflow) => void, string]
    ),
    [
      'decide without the environment names',
      (_b, d) => delete st(d, 'decide').env!.STAGING_ENVIRONMENT,
      'site-deploy#staging: decide does not get STAGING_ENVIRONMENT',
    ],
    // F1
    [
      'a required token',
      (_b, d) => (d.on.workflow_call.secrets.VERCEL_TOKEN.required = true),
      'not an optional VERCEL_TOKEN and RUNTIME_ENV',
    ],
    [
      'the token under another name',
      (_b, d) => (p(d, 'deploy').env!.VERCEL_TOKEN = '${{ secrets.vercel-token }}'),
      'is not VERCEL_TOKEN',
    ],
    [
      'no token check',
      (_b, d) =>
        (d.jobs.staging!.steps = d.jobs.staging!.steps!.filter((s) => !s.name?.startsWith('The Vercel token'))),
      'site-deploy#staging: no check that the environment holds VERCEL_TOKEN',
    ],
    // D4
    [
      'a download by another run id',
      (_b, d) => (p(d, 'Download').env!.RUN_ID = '${{ github.event.workflow_run.id }}'),
      'not by the decided run id',
    ],
    [
      'a deploy step that ignores the decision',
      (_b, d) => delete p(d, 'deploy').if,
      'site-deploy#preview: "Deploy the preview" runs whatever decide decided',
    ],
    [
      'a preview prepare with no root directory',
      (_b, d) => delete p(d, 'Prepare').env!.ROOT_DIRECTORY,
      'site-deploy#preview: prepare does not get main',
    ],
    [
      'a staging prepare that takes the root directory from the artifact',
      (_b, d) => (st(d, 'Prepare').env!.ROOT_DIRECTORY = '${{ steps.decide.outputs.sha }}'),
      'site-deploy#staging: prepare does not get main',
    ],
    [
      'a prepare that ignores the decision',
      (_b, d) => (st(d, 'Prepare').if = 'always()'),
      'site-deploy#staging: "Prepare',
    ],
    // A8
    [
      'an alias not gated by its recheck',
      (_b, d) => (p(d, 'Alias the preview').if = "steps.alias.outputs.alias != ''"),
      '"Alias the preview" is not gated by before-alias',
    ],
    [
      'a comment not gated by its recheck',
      (_b, d) => (p(d, 'Comment the preview URL').if = "steps.deploy.outputs.url != ''"),
      'is not gated by before-comment',
    ],
    [
      'a recheck that checks nothing',
      (_b, d) => (p(d, 'before-comment').run = 'true'),
      'before-comment is not a recheck',
    ],
    // F5, F6, F9
    [
      'an unvalidated URL',
      (_b, d) =>
        (p(d, 'deploy').run = p(d, 'deploy')
          .run!.split('\n')
          .filter((line) => !line.includes('deployment-url'))
          .join('\n')),
      'the deployment URL is not validated',
    ],
    ['a staging deploy with no tip check', (_b, d) => (st(d, 'deploy').if = DECIDED), 'not gated by a tip check'],
    [
      'an unchecked toolkit ref',
      (_b, d) => (d.jobs.preview!.steps = d.jobs.preview!.steps!.slice(1)),
      'site-deploy#preview: toolkit-ref is not checked',
    ],
    [
      'a download before the CLI install',
      (_b, d) => {
        const steps = d.jobs.staging!.steps!;
        const [install] = steps.splice(steps.indexOf(st(d, 'Install the locked')), 1);
        steps.splice(steps.indexOf(st(d, 'Prepare')), 0, install!);
      },
      'site-deploy#staging: the CLI is not installed before the download',
    ],
  ])('fail on %s', (_what, breakIt, message) => {
    const [b, d] = [clone(build), clone(deploy)];
    breakIt(b, d);
    expect(violations(b, d).join('\n')).toContain(message);
  });

  test('the preview concurrency group is the PR number GitHub set, or the run id: never a branch name', () => {
    expect(deploy.jobs.preview!.concurrency!.group).toBe(
      "site-deploy-${{ inputs.artifact-name }}-preview-${{ github.event.workflow_run.pull_requests[0].number || format('run-{0}', github.event.workflow_run.id) }}"
    );
  });

  test('the pinned Vercel CLI default is the version the committed lockfile locks', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, '.github/site-deploy/vercel/package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(ROOT, '.github/site-deploy/vercel/package.json'), 'utf8'));
    expect([deploy.on.workflow_call.inputs['vercel-cli-version'].default, manifest.dependencies.vercel]).toEqual([
      lock.packages['node_modules/vercel'].version,
      lock.packages['node_modules/vercel'].version,
    ]);
  });

  test('takes the Vercel token as an optional VERCEL_TOKEN secret, and the ids as inputs', () => {
    const call = deploy.on.workflow_call;
    expect([
      call.secrets.VERCEL_TOKEN.required,
      call.inputs['vercel-project-id'].required,
      call.inputs['vercel-team-id'].required,
      call.inputs['vercel-environment'].default,
    ]).toEqual([false, true, true, 'staging']);
  });
});

describe('the copyable stubs', () => {
  const buildStub = load(WORKFLOWS.buildStub);
  const deployStub = load(WORKFLOWS.deployStub);
  const deploy = load(WORKFLOWS.deploy);
  const build = load(WORKFLOWS.build);
  const [deployJob] = Object.values(deployStub.jobs);
  const [buildJob] = Object.values(buildStub.jobs);

  test('grant nothing at the top, and each job only what the toolkit job needs', () => {
    expect([buildStub.permissions, deployStub.permissions, buildJob!.permissions, deployJob!.permissions]).toEqual([
      {},
      {},
      build.jobs.build!.permissions,
      deploy.jobs.preview!.permissions,
    ]);
  });

  test('call the toolkit workflows at one pinned sha, which the deploy also passes as toolkit-ref', () => {
    const sha = (uses: string) => /@([0-9a-f]{40})$/.exec(uses)?.[1];
    expect([
      buildJob!.uses!.replace(/@.*$/, ''),
      deployJob!.uses!.replace(/@.*$/, ''),
      sha(deployJob!.uses!),
      deployJob!.with!['toolkit-ref'],
    ]).toEqual([
      'pebble-tech/toolkit/.github/workflows/site-build.yml',
      'pebble-tech/toolkit/.github/workflows/site-deploy.yml',
      sha(buildJob!.uses!),
      sha(buildJob!.uses!),
    ]);
  });

  test('the deploy stub gets the same working-directory as the build stub, so the project root exists for the CLI', () => {
    expect([deployJob!.with!['working-directory'], buildJob!.with!['working-directory']]).toEqual([
      'apps/marketing',
      'apps/marketing',
    ]);
  });

  test('the deploy runs on the build stub completing, checks its path, and passes every input the workflow knows', () => {
    const inputs = deploy.on.workflow_call.inputs;
    expect([
      deployStub.on.workflow_run,
      deployJob!.with!['build-workflow'],
      deployJob!.with!['artifact-name'],
      Object.keys(deployJob!.with!).filter((key) => !(key in inputs)),
      deployJob!.secrets,
    ]).toEqual([
      { workflows: [buildStub.name], types: ['completed'] },
      '.github/workflows/site-build.yml',
      buildJob!.with!['artifact-name'],
      [],
      { VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}', RUNTIME_ENV: '${{ secrets.RUNTIME_ENV }}' },
    ]);
  });
});

// ---- the script, as the workflow runs it ----

const run = promisify(execFile);
const REPO = 'pebble-tech/site';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface Api {
  routes: Record<string, unknown>;
  calls: { method: string; path: string; body: string }[];
}
let api: Api;
let server: ReturnType<typeof createServer>;
let apiUrl = '';

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    api.calls.push({ method: request.method!, path: request.url!, body });
    const key = `${request.method} ${request.url}`;
    const found = key in api.routes ? api.routes[key] : api.routes[`GET ${request.url}`];
    response.writeHead(found === undefined ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(found ?? { message: 'Not Found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const runPayload = (overrides: Record<string, unknown> = {}) => ({
  id: 4242,
  head_sha: SHA,
  event: 'pull_request',
  conclusion: 'success',
  path: '.github/workflows/site-build.yml',
  head_branch: 'feature',
  head_repository: { full_name: REPO },
  ...overrides,
});

async function script(args: string[], env: Record<string, string>, event?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'site-deploy-'));
  const outputFile = join(dir, 'output');
  writeFileSync(outputFile, '');
  const eventFile = join(dir, 'event.json');
  writeFileSync(eventFile, JSON.stringify(event ?? {}));
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: apiUrl,
        GITHUB_TOKEN: 'token-for-the-fake-api',
        GITHUB_REPOSITORY: REPO,
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_OUTPUT: outputFile,
        BUILD_WORKFLOW: '.github/workflows/site-build.yml',
        VERCEL_PROJECT_ID: 'prj_abc123',
        VERCEL_ORG_ID: 'team_abc123',
        PREVIEW_ENVIRONMENT: 'preview',
        STAGING_ENVIRONMENT: 'staging',
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(outputFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    return { code: 0, outputs, stdout, stderr: '' };
  } catch (error: any) {
    return { code: error.code as number, outputs: {}, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

const pull = (number: number, sha = SHA, repo = REPO, state = 'open') => ({
  number,
  state,
  head: { sha, repo: { full_name: repo } },
  base: { repo: { full_name: REPO } },
});

describe('decide: preview', () => {
  const routes = (overrides: Record<string, unknown> = {}) => ({
    [`GET /repos/${REPO}/actions/runs/4242`]: runPayload(),
    [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [pull(17)],
    ...overrides,
  });

  test("deploys this repository's PR build, with the PR number from the API", async () => {
    api = { routes: routes(), calls: [] };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload() });
    expect([result.code, result.outputs]).toEqual([0, { deploy: 'true', pr: '17', 'run-id': '4242', sha: SHA }]);
  });

  test.each<[string, Record<string, unknown>]>([
    ['the PR head moved on', { [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [pull(17, OTHER)] }],
    ['the PR closed', { [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [pull(17, SHA, REPO, 'closed')] }],
    ['two PRs share the head', { [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [pull(17), pull(18)] }],
    [
      'the PR is from a fork',
      { [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [pull(17, SHA, 'someone/site')] },
    ],
    [
      'a second open PR with the head on a later page',
      {
        [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [
          pull(17),
          ...Array.from({ length: 99 }, (_, i) => pull(100 + i, OTHER)),
        ],
        [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=2`]: [pull(18)],
      },
    ],
    [
      "the PR's base is another repository",
      {
        [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [
          { ...pull(17), base: { repo: { full_name: 'someone/site' } } },
        ],
      },
    ],
  ])('skips, without failing, when %s', async (_what, overrides) => {
    api = { routes: routes(overrides), calls: [] };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload() });
    expect([result.code, result.outputs.deploy, result.stdout]).toEqual([
      0,
      'false',
      expect.stringContaining('::notice::'),
    ]);
  });

  // The open PR is found among open PRs, not the commit's associations: a commit already on main is associated with
  // the PR that merged it, while an open PR to another branch waits for its preview.
  test('deploys the one open PR whose head is the sha, found on a later page of open PRs', async () => {
    api = {
      routes: {
        [`GET /repos/${REPO}/actions/runs/4242`]: runPayload(),
        [`GET /repos/${REPO}/commits/${SHA}/pulls`]: [{ ...pull(3, SHA, REPO, 'closed'), merged_at: '2026-11-01' }],
        [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: Array.from({ length: 100 }, (_, i) =>
          pull(100 + i, OTHER)
        ),
        [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=2`]: [pull(17)],
      },
      calls: [],
    };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload() });
    expect([result.code, result.outputs.deploy, result.outputs.pr]).toEqual([0, 'true', '17']);
  });

  test('counts a PR listed on two pages, as it moves between them, as one match', async () => {
    api = {
      routes: {
        [`GET /repos/${REPO}/actions/runs/4242`]: runPayload(),
        [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [
          pull(17),
          ...Array.from({ length: 99 }, (_, i) => pull(100 + i, OTHER)),
        ],
        [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=2`]: [pull(17)],
      },
      calls: [],
    };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload() });
    expect([result.code, result.outputs.deploy, result.outputs.pr]).toEqual([0, 'true', '17']);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ['a fork build', { head_repository: { full_name: 'someone/site' } }, 'ran on someone/site'],
    ['a failed build', { conclusion: 'failure' }, 'concluded failure'],
    ['a push build', { event: 'push' }, 'ran for push, not pull_request'],
    ['another workflow', { path: '.github/workflows/evil.yml' }, 'is .github/workflows/evil.yml'],
  ])('refuses %s', async (_what, overrides, message) => {
    api = { routes: routes(), calls: [] };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload(overrides) });
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining(message)]);
  });

  test('refuses an event the API does not confirm', async () => {
    api = { routes: routes({ [`GET /repos/${REPO}/actions/runs/4242`]: runPayload({ head_sha: OTHER }) }), calls: [] };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload() });
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining("the run's headSha")]);
  });
});

describe('decide: the Vercel ids main passes', () => {
  const routes = {
    [`GET /repos/${REPO}/actions/runs/4242`]: runPayload(),
    [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [pull(17)],
  };
  test.each([
    ['an empty project id', { VERCEL_PROJECT_ID: '' }, 'vercel-project-id "" is not prj_'],
    ['a project name', { VERCEL_PROJECT_ID: 'marketing-web' }, 'vercel-project-id "marketing-web" is not prj_'],
    ['an empty team id', { VERCEL_ORG_ID: '' }, 'vercel-team-id "" is not team_'],
    ['a team slug', { VERCEL_ORG_ID: 'pebble-tech' }, 'vercel-team-id "pebble-tech" is not team_'],
  ])('refuses %s', async (_what, env, message) => {
    api = { routes, calls: [] };
    const result = await script(['decide', 'preview'], env, { workflow_run: runPayload() });
    expect([result.code, result.stderr, result.outputs]).toEqual([1, expect.stringContaining(message), {}]);
  });
});

describe('decide: the GitHub environments', () => {
  const routes = {
    [`GET /repos/${REPO}/actions/runs/4242`]: runPayload(),
    [`GET /repos/${REPO}/pulls?state=open&per_page=100&page=1`]: [pull(17)],
  };
  test.each([
    ['the same environment twice', { STAGING_ENVIRONMENT: 'preview' }, 'are both preview: each needs its own'],
    ['production with a trailing space', { STAGING_ENVIRONMENT: 'production ' }, 'is not a plain environment name'],
    ['production after a tab', { STAGING_ENVIRONMENT: '\tproduction' }, 'is not a plain environment name'],
    [
      'production with a zero-width space',
      { PREVIEW_ENVIRONMENT: 'produc\u200btion' },
      'is not a plain environment name',
    ],
    [
      'production in full-width letters',
      { STAGING_ENVIRONMENT: '\uff50\uff52\uff4f\uff44' },
      'is not a plain environment name',
    ],
    ['prod', { STAGING_ENVIRONMENT: 'prod' }, 'staging-environment is prod: site-deploy never runs in production'],
    ['PROD', { PREVIEW_ENVIRONMENT: 'PROD' }, 'preview-environment is PROD'],
    [
      'preview and "preview " as two names',
      { STAGING_ENVIRONMENT: 'preview ' },
      'staging-environment "preview " is not a plain',
    ],
    ['the same environment in another case', { STAGING_ENVIRONMENT: 'Preview' }, 'are both preview'],
    [
      'production as the preview environment',
      { PREVIEW_ENVIRONMENT: 'production' },
      'preview-environment is production',
    ],
    [
      'Production as the staging environment',
      { STAGING_ENVIRONMENT: 'Production' },
      'staging-environment is Production',
    ],
    [
      'PRODUCTION as the staging environment',
      { STAGING_ENVIRONMENT: 'PRODUCTION' },
      'staging-environment is PRODUCTION',
    ],
    ['no staging environment', { STAGING_ENVIRONMENT: '' }, 'staging-environment is not set'],
  ])('refuses %s', async (_what, env, message) => {
    api = { routes, calls: [] };
    const result = await script(['decide', 'preview'], env, { workflow_run: runPayload() });
    expect([result.code, result.stderr, result.outputs]).toEqual([1, expect.stringContaining(message), {}]);
  });

  test('takes two distinct environments per app', async () => {
    api = { routes, calls: [] };
    const result = await script(
      ['decide', 'preview'],
      { PREVIEW_ENVIRONMENT: 'preview-marketing', STAGING_ENVIRONMENT: 'staging-marketing' },
      { workflow_run: runPayload() }
    );
    expect([result.code, result.outputs.deploy]).toEqual([0, 'true']);
  });
});

describe('decide: staging', () => {
  const push = () => runPayload({ event: 'push', head_branch: 'main' });
  const routes = (tip: string) => ({
    [`GET /repos/${REPO}/actions/runs/4242`]: push(),
    [`GET /repos/${REPO}/branches/main`]: { commit: { sha: tip } },
  });
  const env = { DEFAULT_BRANCH: 'main', VERCEL_ENVIRONMENT: 'staging' };

  // A7: the tip read is the default branch's, whatever branch the event names.
  test("skips a push of another branch whose own tip is the sha, since it is not the default branch's tip", async () => {
    api = {
      routes: {
        [`GET /repos/${REPO}/actions/runs/4242`]: runPayload({ event: 'push', head_branch: 'feature' }),
        [`GET /repos/${REPO}/branches/feature`]: { commit: { sha: SHA } },
        [`GET /repos/${REPO}/branches/main`]: { commit: { sha: OTHER } },
      },
      calls: [],
    };
    const result = await script(['decide', 'staging'], env, {
      workflow_run: runPayload({ event: 'push', head_branch: 'feature' }),
    });
    expect([result.code, result.outputs.deploy, api.calls.map((c) => c.path)]).toEqual([
      0,
      'false',
      [`/repos/${REPO}/actions/runs/4242`, `/repos/${REPO}/branches/main`],
    ]);
  });

  // F6: the tip is read again right before the deploy.
  test("tip is true while the sha is the default branch's tip, false once it moved", async () => {
    const outcome = async (tip: string) => {
      api = { routes: routes(tip), calls: [] };
      return (await script(['tip'], { DEFAULT_BRANCH: 'main', SHA })).outputs.current;
    };
    expect([await outcome(SHA), await outcome(OTHER)]).toEqual(['true', 'false']);
  });

  test('tip reads the default branch the event names, such as trunk, not main', async () => {
    api = {
      routes: {
        [`GET /repos/${REPO}/branches/trunk`]: { commit: { sha: SHA } },
        [`GET /repos/${REPO}/branches/main`]: { commit: { sha: OTHER } },
      },
      calls: [],
    };
    const result = await script(['tip'], { DEFAULT_BRANCH: 'trunk', SHA });
    expect([result.outputs.current, api.calls.map((c) => c.path)]).toEqual(['true', [`/repos/${REPO}/branches/trunk`]]);
  });

  test("deploys a push build whose sha is the default branch's tip", async () => {
    api = { routes: routes(SHA), calls: [] };
    const result = await script(['decide', 'staging'], env, { workflow_run: push() });
    expect([result.code, result.outputs]).toEqual([0, { deploy: 'true', 'run-id': '4242', sha: SHA }]);
  });

  test('skips a build the branch has moved past, whatever head_branch says', async () => {
    api = { routes: routes(OTHER), calls: [] };
    const result = await script(['decide', 'staging'], env, { workflow_run: push() });
    expect([result.code, result.outputs.deploy]).toEqual([0, 'false']);
  });

  test.each(['production', 'preview', 'Staging'])('refuses the environment %s', async (name) => {
    api = { routes: routes(SHA), calls: [] };
    const result = await script(['decide', 'staging'], { ...env, VERCEL_ENVIRONMENT: name }, { workflow_run: push() });
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining('is not a custom environment')]);
  });

  test('refuses a pull-request build', async () => {
    api = { routes: routes(SHA), calls: [] };
    const result = await script(['decide', 'staging'], env, { workflow_run: runPayload() });
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining('not push')]);
  });
});

// ---- artifact prep (A5, D1, D2) ----

function artifact(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-artifact-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();

const OUTPUT = {
  'config.json': JSON.stringify({ version: 3 }),
  'static/index.html': '<h1>site</h1>',
  'functions/api.func/.vc-config.json': JSON.stringify({ runtime: 'nodejs24.x', handler: 'index.mjs' }),
  'functions/api.func/index.mjs': 'export default () => new Response("ok")',
};

describe('prepare', () => {
  test('copies the Build Output alone into a fresh .vercel/output, leaving out builds.json and any project link', async () => {
    const from = artifact({
      ...OUTPUT,
      'builds.json': JSON.stringify({ target: 'production' }),
      'project.json': JSON.stringify({ projectId: 'prj_attacker', orgId: 'team_attacker' }),
    });
    const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
    const result = await script(['prepare', from, to], {});
    expect([result.code, tree(to)]).toEqual([
      0,
      [
        '.vercel/output/config.json',
        '.vercel/output/functions/api.func/.vc-config.json',
        '.vercel/output/functions/api.func/index.mjs',
        '.vercel/output/static/index.html',
      ],
    ]);
  });

  test('a hostile project.json, package.json or lifecycle script never reaches the deploy directory', async () => {
    const from = artifact({
      ...OUTPUT,
      'project.json': JSON.stringify({ projectId: 'prj_attacker' }),
      'static/package.json': JSON.stringify({ scripts: { postinstall: 'curl evil' } }),
    });
    const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
    await script(['prepare', from, to], {});
    expect([
      existsSync(join(to, '.vercel/project.json')),
      existsSync(join(to, 'package.json')),
      readdirSync(to),
    ]).toEqual([false, false, ['.vercel']]);
  });

  test.each<[string, Record<string, string>, string]>([
    ['a .vercel directory inside', { ...OUTPUT, 'static/.vercel/project.json': '{}' }, 'is a .vercel directory'],
    [
      'a function config with filePathMap',
      { ...OUTPUT, 'functions/api.func/.vc-config.json': JSON.stringify({ filePathMap: { 'a.js': '/etc/passwd' } }) },
      'sets filePathMap',
    ],
    [
      'a function config with its own environment',
      { ...OUTPUT, 'functions/api.func/.vc-config.json': JSON.stringify({ environment: { DATABASE_URL: 'x' } }) },
      'sets environment',
    ],
    ['no config.json', { 'static/index.html': 'x' }, 'no Build Output config.json with version 3'],
    ['config.json of another version', { ...OUTPUT, 'config.json': '{"version":2}' }, 'version 3'],
    [
      'a config.json that is not JSON',
      { ...OUTPUT, 'config.json': 'secretish{' },
      'config.json in the artifact is not valid JSON',
    ],
  ])('refuses %s', async (_what, files, message) => {
    const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
    const result = await script(['prepare', artifact(files), to], {});
    expect([result.code, result.stderr, readdirSync(to)]).toEqual([1, expect.stringContaining(message), []]);
  });

  // F7: the destination is the fresh directory; anything already there could ride along with the deploy.
  test('refuses a destination that is not empty', async () => {
    const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
    writeFileSync(join(to, 'package.json'), '{"scripts":{"postinstall":"curl evil"}}');
    const result = await script(['prepare', artifact(OUTPUT), to], {});
    expect([result.code, result.stderr, readdirSync(to)]).toEqual([
      1,
      expect.stringContaining('is not empty'),
      ['package.json'],
    ]);
  });

  describe('with the project root directory', () => {
    test('makes it an empty directory beside .vercel/output, and no file anywhere else', async () => {
      const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
      const result = await script(['prepare', artifact(OUTPUT), to, 'apps/marketing'], {});
      expect([
        result.code,
        readdirSync(join(to, 'apps/marketing')),
        readdirSync(to).sort(),
        readdirSync(join(to, 'apps')),
        tree(to).every((file) => file.startsWith('.vercel/output/')),
      ]).toEqual([0, [], ['.vercel', 'apps'], ['marketing'], true]);
    });

    test.each(['', undefined])('without one (%j) leaves the tree as it was', async (root) => {
      const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
      const result = await script(['prepare', artifact(OUTPUT), to, ...(root === undefined ? [] : [root])], {});
      expect([result.code, readdirSync(to)]).toEqual([0, ['.vercel']]);
    });

    test.each([
      ['a parent segment', '../marketing'],
      ['a parent segment in the middle', 'apps/../marketing'],
      ['an absolute path', '/apps/marketing'],
      ['an empty segment', 'apps//marketing'],
      ['a trailing slash', 'apps/marketing/'],
      ['a dot segment', './apps'],
      ['a backslash', 'apps\\marketing'],
      ['a newline', 'apps\nmarketing'],
      ['more than 64 bytes', `apps/${'a'.repeat(60)}`],
      ['.vercel itself', '.vercel'],
      ['a path inside .vercel', '.vercel/output/apps'],
    ])('refuses %s as the root directory, and creates nothing', async (_what, root) => {
      const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
      const result = await script(['prepare', artifact(OUTPUT), to, root], {});
      expect([result.code, result.stderr, readdirSync(to)]).toEqual([1, expect.stringContaining('root directory'), []]);
    });

    test('takes exactly 64 bytes', async () => {
      const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
      const root = `apps/${'a'.repeat(59)}`;
      const result = await script(['prepare', artifact(OUTPUT), to, root], {});
      expect([result.code, readdirSync(join(to, root))]).toEqual([0, []]);
    });

    test('refuses a root directory that is already in the destination, and adds nothing', async () => {
      const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
      mkdirSync(join(to, 'apps/marketing'), { recursive: true });
      const result = await script(['prepare', artifact(OUTPUT), to, 'apps/marketing'], {});
      expect([result.code, result.stderr, tree(to)]).toEqual([1, expect.stringContaining('is not empty'), []]);
    });
  });

  test.each([
    ['a file symlink', '/etc/passwd'],
    ['a directory symlink', '/'],
  ])('refuses %s', async (_what, target) => {
    const from = artifact(OUTPUT);
    symlinkSync(target, join(from, 'static/link'));
    const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
    const result = await script(['prepare', from, to], {});
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining('static/link is a symlink')]);
  });
});

describe('runtime-env', () => {
  const runtime = async (RUNTIME_ENV: string, RUNTIME_VARS = '{}') => {
    const file = join(mkdtempSync(join(tmpdir(), 'site-env-')), 'args');
    const result = await script(['runtime-env', file], { RUNTIME_ENV, RUNTIME_VARS });
    return { ...result, args: existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [] };
  };

  test('masks each secret value and passes every var as one --env argument', async () => {
    const result = await runtime('{"DATABASE_URL":"postgres://x y","API_KEY":"k1"}', '{"SITE_ENV":"preview"}');
    expect([result.code, result.stdout, result.args]).toEqual([
      0,
      '::add-mask::postgres://x y\n::add-mask::k1\n',
      ['--env', 'SITE_ENV=preview', '--env', 'DATABASE_URL=postgres://x y', '--env', 'API_KEY=k1'],
    ]);
  });

  // The parser's own message quotes the input's first characters, before any add-mask line could hide them.
  test('refuses a RUNTIME_ENV that is not JSON without printing any of it', async () => {
    const secret = 'postgres://user:pw@host/db';
    const result = await runtime(secret);
    const printed = `${result.stdout}${result.stderr}`;
    const prefixes = Array.from({ length: secret.length - 1 }, (_, i) => secret.slice(0, i + 2));
    expect([result.code, result.stderr, prefixes.filter((prefix) => printed.includes(prefix))]).toEqual([
      1,
      expect.stringContaining('RUNTIME_ENV is not valid JSON'),
      [],
    ]);
  });

  test('escapes the mask as a workflow command reads it, and passes the value itself unchanged', async () => {
    const result = await runtime('{"API_KEY":"a%25b%0Ac"}');
    expect([result.code, result.stdout, result.args]).toEqual([
      0,
      '::add-mask::a%2525b%250Ac\n',
      ['--env', 'API_KEY=a%25b%0Ac'],
    ]);
  });

  test.each([
    ['a key that is not an env var name', '{"bad-key":"x"}', 'is not an env var name'],
    ['a value over two lines', '{"A":"x\\ny"}', 'is not a one-line string'],
    ['an array', '["A"]', 'is not a JSON object'],
  ])('refuses %s', async (_what, json, message) => {
    const result = await runtime(json);
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining(message)]);
  });
});

describe('alias', () => {
  const alias = (ALIAS_TEMPLATE: string, PR = '17', PROTECTED_HOSTS = 'new.pebbletech.my pebbletech.my') =>
    script(['alias'], { ALIAS_TEMPLATE, PR, PROTECTED_HOSTS });

  test("is main's template with the verified PR number, or nothing without one", async () => {
    const [set, unset] = [await alias('marketing-pr-{pr}.vercel.app'), await alias('')];
    expect([set.outputs, unset.outputs]).toEqual([{ alias: 'marketing-pr-17.vercel.app' }, { alias: '' }]);
  });

  test.each([
    ['a production hostname', 'pebbletech.my', 'is not <name>-pr-17.vercel.app'],
    ['the project production URL', 'marketing.vercel.app', 'is not <name>-pr-17.vercel.app'],
    ['another PR number', 'marketing-pr-1{pr}.vercel.app', 'is not <name>-pr-17.vercel.app'],
    ['a custom domain', 'pr-{pr}.pebbletech.my', 'is not <name>-pr-17.vercel.app'],
  ])('refuses %s', async (_what, template, message) => {
    const result = await alias(template);
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining(message)]);
  });

  test.each([
    ['a prefix before the preview name', 'x.marketing-pr-{pr}.vercel.app'],
    ['a suffix after vercel.app', 'marketing-pr-{pr}.vercel.app.evil.com'],
    ['a path', 'marketing-pr-{pr}.vercel.app/x'],
    ['a second PR number', 'marketing-pr-{pr}-pr-{pr}.vercel.app.x'],
  ])('refuses an alias with %s', async (_what, template) => {
    const result = await alias(template);
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining('is not <name>-pr-17.vercel.app')]);
  });

  test('refuses a protected hostname written in another case', async () => {
    const result = await alias('marketing-pr-{pr}.vercel.app', '17', 'Marketing-PR-17.vercel.app');
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining('is a production or staging hostname')]);
  });

  test('refuses a protected hostname even when it has the preview shape', async () => {
    const result = await alias('marketing-pr-{pr}.vercel.app', '17', 'marketing-pr-17.vercel.app');
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining('is a production or staging hostname')]);
  });
});

describe('deployment-url', () => {
  const url = async (text: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'site-url-')), 'out');
    writeFileSync(file, text);
    return script(['deployment-url', file], {});
  };

  test("is the CLI output's last line, a https://<name>.vercel.app URL", async () => {
    const result = await url(
      'Vercel CLI 65.15.0\nInspect: https://vercel.com/x\nhttps://marketing-abc123.vercel.app\n'
    );
    expect([result.code, result.outputs]).toEqual([0, { url: 'https://marketing-abc123.vercel.app' }]);
  });

  test.each([
    ['another host last', 'https://marketing-abc.vercel.app\nhttps://evil.example.com'],
    ['a production domain', 'https://pebbletech.my'],
    ['a path', 'https://marketing-abc.vercel.app/x'],
    ['nothing', ''],
    ['an injected output line', 'https://a.vercel.app\nurl=https://evil.example.com'],
  ])('refuses %s', async (_what, text) => {
    const result = await url(text);
    expect([result.code, result.stderr, result.outputs]).toEqual([1, expect.stringContaining('is not a https://'), {}]);
  });
});

describe('recheck and comment', () => {
  test('recheck is false once the PR head moved or the PR closed, true while it still has the sha', async () => {
    const outcome = async (pr: unknown) => {
      api = { routes: { [`GET /repos/${REPO}/pulls/17`]: pr }, calls: [] };
      return (await script(['recheck'], { PR: '17', SHA })).outputs.current;
    };
    expect([
      await outcome(pull(17)),
      await outcome(pull(17, OTHER)),
      await outcome(pull(17, SHA, REPO, 'closed')),
      await outcome(pull(17, SHA, 'someone/site')),
    ]).toEqual(['true', 'false', 'false', 'false']);
  });

  test('comments the URL on the verified PR, then updates that comment on the next push', async () => {
    const env = { PR: '17', SHA, ARTIFACT_NAME: 'marketing-output', DEPLOYMENT_URL: 'https://x.vercel.app', ALIAS: '' };
    api = { routes: { [`GET /repos/${REPO}/issues/17/comments?per_page=100&page=1`]: [] }, calls: [] };
    await script(['comment'], env);
    const posted = api.calls.find((c) => c.method === 'POST')!;
    const body = JSON.parse(posted.body).body as string;
    api = {
      routes: {
        [`GET /repos/${REPO}/issues/17/comments?per_page=100&page=1`]: [
          { id: 9, user: { login: 'github-actions[bot]' }, body },
        ],
        [`PATCH /repos/${REPO}/issues/comments/9`]: {},
      },
      calls: [],
    };
    const second = await script(['comment'], { ...env, DEPLOYMENT_URL: 'https://y.vercel.app' });
    const patched = JSON.parse(api.calls.find((c) => c.method === 'PATCH')!.body).body as string;
    expect([
      posted.path,
      body.includes('https://x.vercel.app'),
      second.code,
      patched.includes('https://y.vercel.app'),
      patched.includes('https://x.vercel.app'),
      api.calls.map((c) => `${c.method} ${c.path}`),
    ]).toEqual([
      `/repos/${REPO}/issues/17/comments`,
      true,
      0,
      true,
      false,
      [`GET /repos/${REPO}/issues/17/comments?per_page=100&page=1`, `PATCH /repos/${REPO}/issues/comments/9`],
    ]);
  });

  test('finds its comment on a later page, and does not post a second one', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, user: { login: 'someone' }, body: 'hi' }));
    const marker = '<!-- pebbletech site-deploy marketing-output -->';
    api = {
      routes: {
        [`GET /repos/${REPO}/issues/17/comments?per_page=100&page=1`]: others,
        [`GET /repos/${REPO}/issues/17/comments?per_page=100&page=2`]: [
          { id: 9, user: { login: 'github-actions[bot]' }, body: `${marker}\n\nold` },
        ],
        [`PATCH /repos/${REPO}/issues/comments/9`]: {},
      },
      calls: [],
    };
    const result = await script(['comment'], {
      PR: '17',
      SHA,
      ARTIFACT_NAME: 'marketing-output',
      DEPLOYMENT_URL: 'https://y.vercel.app',
      ALIAS: '',
    });
    expect([result.code, api.calls.map((c) => `${c.method} ${c.path}`)]).toEqual([
      0,
      [
        `GET /repos/${REPO}/issues/17/comments?per_page=100&page=1`,
        `GET /repos/${REPO}/issues/17/comments?per_page=100&page=2`,
        `PATCH /repos/${REPO}/issues/comments/9`,
      ],
    ]);
  });
});

describe('the build stub', () => {
  test('marks only a pull request build as a preview', () => {
    const [job] = Object.values(load(WORKFLOWS.buildStub).jobs);
    expect(job!.with!['build-env']).toBe(
      `\${{ github.event_name == 'pull_request' && '{"SITE_ENV":"preview"}' || '{"SITE_ENV":"staging"}' }}`
    );
  });
});

describe('the script run from an unusual path', () => {
  const runFrom = async (path: string) => {
    const outputFile = join(mkdtempSync(join(tmpdir(), 'site-out-')), 'output');
    writeFileSync(outputFile, '');
    const { stdout } = await run(process.execPath, [path, 'alias'], {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: outputFile,
        ALIAS_TEMPLATE: 'marketing-pr-{pr}.vercel.app',
        PR: '17',
      },
    });
    return [stdout, readFileSync(outputFile, 'utf8')];
  };
  const copyInto = (dir: string) => {
    writeFileSync(join(dir, 'site-deploy.mjs'), readFileSync(SCRIPT));
    return dir;
  };
  const ran = ['alias=marketing-pr-17.vercel.app\n', 'alias=marketing-pr-17.vercel.app\n'];

  test('still runs its command from a path with a space', async () => {
    const dir = copyInto(mkdtempSync(join(tmpdir(), 'site deploy ')));
    expect(await runFrom(join(dir, 'site-deploy.mjs'))).toEqual(ran);
  });

  test('fails loudly, rather than do nothing, when run under its name from a path that is not it', async () => {
    const loader = `process.argv[1] = '/nowhere/site-deploy.mjs'; await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`;
    const result = await run(process.execPath, ['--input-type=module', '-e', loader], {
      env: { PATH: process.env.PATH },
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: any) => ({ code: error.code as number, stderr: String(error.stderr) })
    );
    expect(result).toEqual({
      code: 1,
      stderr: expect.stringContaining('/nowhere/site-deploy.mjs does not resolve to'),
    });
  });

  // Node gives the module its real path, while argv[1] keeps the link's.
  test('still runs its command through a symlinked directory', async () => {
    const real = copyInto(mkdtempSync(join(tmpdir(), 'site-real-')));
    const link = join(mkdtempSync(join(tmpdir(), 'site-link-')), 'toolkit');
    symlinkSync(real, link);
    expect(await runFrom(join(link, 'site-deploy.mjs'))).toEqual(ran);
  });
});

describe("site-build's build-env step, run as the workflow runs it", () => {
  const buildEnv = async (BUILD_ENV: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'site-build-env-'));
    const githubEnv = join(dir, 'env');
    writeFileSync(githubEnv, '');
    const runText = load(WORKFLOWS.build).jobs.build!.steps!.find((s) => s.name?.startsWith('Build-time env'))!.run!;
    try {
      await run('bash', ['-e', '-c', runText], { env: { PATH: process.env.PATH, BUILD_ENV, GITHUB_ENV: githubEnv } });
      return { code: 0, env: readFileSync(githubEnv, 'utf8'), stderr: '' };
    } catch (error: any) {
      return { code: error.code as number, env: readFileSync(githubEnv, 'utf8'), stderr: String(error.stderr) };
    }
  };

  test('writes each var, and takes an empty object', async () => {
    expect([await buildEnv('{"SITE_ENV":"preview","API_BASE":"https://x"}'), await buildEnv('{}')]).toEqual([
      { code: 0, env: 'SITE_ENV=preview\nAPI_BASE=https://x\n', stderr: '' },
      { code: 0, env: '', stderr: '' },
    ]);
  });

  test.each([
    ['true', 'build-env is not a JSON object'],
    ['[]', 'build-env is not a JSON object'],
    ['null', 'build-env is not a JSON object'],
    ['{"NODE_OPTIONS":"--max-old-space-size=4096"}', 'build-env cannot set NODE_OPTIONS'],
    ['postgres://user:pw@host/db', 'build-env is not valid JSON'],
  ])('refuses %s', async (value, message) => {
    const result = await buildEnv(value);
    // Nothing of the value itself in the message: the parser's own would quote it.
    expect([result.code, result.stderr, result.env, result.stderr.includes(value.slice(0, 10))]).toEqual([
      1,
      expect.stringContaining(message),
      '',
      false,
    ]);
  });
});
