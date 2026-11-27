import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
  name?: string;
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

const PIN = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const FORBIDDEN = [/--prod\b/, /\bpromote\b/, /production/, /\bvercel\s+(?:link|pull)\b/, /--scope\b/, /--target\b/];

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
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('./')) found.push(`${where}: uses ${step.uses}, which a reusable workflow cannot`);
        if (step.uses && !PIN.test(step.uses)) found.push(`${where}: ${step.uses} is not pinned by sha`);
        if (step.run?.includes('${{')) found.push(`${where}: an expression in run (${step.name})`);
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
    const condition = (job.if ?? '').replace(/\s+/g, ' ');
    for (const clause of [
      `github.event.workflow_run.event == '${event}'`,
      "github.event.workflow_run.conclusion == 'success'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      if (!condition.includes(clause)) found.push(`${where}: its job-level if lacks ${clause}`);
    }
    if (!job.environment) found.push(`${where}: no environment`);
    if (JSON.stringify(job.permissions) !== JSON.stringify(permissions)) {
      found.push(`${where}: permissions ${JSON.stringify(job.permissions)}`);
    }
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@') && step.with?.repository !== 'pebble-tech/toolkit') {
        found.push(`${where}: checks out something other than the toolkit`);
      }
      const vercel = step.run?.includes('/vercel/node_modules/.bin/vercel') && !step.run.includes('--version');
      if (vercel && (step as any)['working-directory'] !== '${{ runner.temp }}/deploy') {
        found.push(`${where}: runs vercel outside the prepared directory (${step.name})`);
      }
      if (vercel && (step.env?.GITHUB_TOKEN || (job as any).env?.GITHUB_TOKEN)) {
        found.push(`${where}: the GitHub token reaches the Vercel CLI (${step.name})`);
      }
      if (vercel && step.env?.VERCEL_PROJECT_ID !== '${{ inputs.vercel-project-id }}') {
        found.push(`${where}: the project id is not main's input (${step.name})`);
      }
      if (vercel && step.env?.VERCEL_ORG_ID !== '${{ inputs.vercel-team-id }}') {
        found.push(`${where}: the team id is not main's input (${step.name})`);
      }
      if (step.run?.includes('npm ci') && !step.run.includes('--ignore-scripts')) {
        found.push(`${where}: installs with scripts on`);
      }
      if (/\b(pnpm|npm (?:install|run|exec)|npx|yarn)\b/.test(step.run ?? '')) found.push(`${where}: runs ${step.run}`);
    }
    const deploys = (job.steps ?? []).filter((s) => / deploy --prebuilt /.test(s.run ?? ''));
    const target = id === 'preview' ? '--environment=preview ' : '--environment="$VERCEL_ENVIRONMENT" ';
    if (deploys.length !== 1 || !deploys[0]!.run!.includes(target))
      found.push(`${where}: does not deploy with ${target}`);
  }
  const aliases = (deploy.jobs.staging?.steps ?? []).filter((s) => s.run?.includes('alias'));
  if (aliases.length) found.push('site-deploy#staging: sets an alias');
  const comment = deploy.jobs.preview?.steps?.find((s) => s.run?.endsWith('site-deploy.mjs" comment'));
  if (comment?.env?.PR !== '${{ steps.decide.outputs.pr }}')
    found.push('site-deploy#preview: the comment PR is not the verified one');
  return found;
}

describe('the site workflows', () => {
  const build = load(WORKFLOWS.build);
  const deploy = load(WORKFLOWS.deploy);

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
      'head_repository',
    ],
    ['a production deploy', (_b, d) => (d.jobs.staging!.steps![6]!.run += ' --prod'), 'matches /--prod\\b/'],
    ['a promote', (_b, d) => (d.jobs.staging!.steps![6]!.run = 'vercel promote x'), 'matches /\\bpromote\\b/'],
    ['vercel link', (_b, d) => (d.jobs.preview!.steps![6]!.run += '\nvercel link --yes'), 'vercel'],
    [
      'an expression in run',
      (_b, d) => (d.jobs.preview!.steps![1]!.run = 'echo ${{ github.event.workflow_run.head_branch }}'),
      'an expression in run',
    ],
    ['a checkout of the product', (_b, d) => (d.jobs.preview!.steps![0]!.with = {}), 'other than the toolkit'],
    ['scripts on', (_b, d) => (d.jobs.preview!.steps![4]!.run = 'npm ci --prefix x'), 'installs with scripts on'],
    ['an artifact project id', (_b, d) => (d.jobs.preview!.steps![6]!.env!.VERCEL_PROJECT_ID = 'x'), 'not main'],
    ['an install from the artifact', (_b, d) => (d.jobs.preview!.steps![3]!.run += '\npnpm install'), 'runs'],
    [
      'the PR number from elsewhere',
      (_b, d) => (d.jobs.preview!.steps!.at(-1)!.env!.PR = '${{ env.PR }}'),
      'not the verified',
    ],
    [
      'the GitHub token in the job env',
      (_b, d) => ((d.jobs.preview as any).env.GITHUB_TOKEN = '${{ github.token }}'),
      'reaches the Vercel CLI',
    ],
    ['no concurrency', (_b, d) => delete d.jobs.preview!.concurrency, 'site-deploy#preview: no concurrency'],
  ])('fail on %s', (_what, breakIt, message) => {
    const [b, d] = [clone(build), clone(deploy)];
    breakIt(b, d);
    expect(violations(b, d).join('\n')).toContain(message);
  });

  test('the pinned Vercel CLI default is the version the committed lockfile locks', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, '.github/site-deploy/vercel/package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(ROOT, '.github/site-deploy/vercel/package.json'), 'utf8'));
    expect([deploy.on.workflow_call.inputs['vercel-cli-version'].default, manifest.dependencies.vercel]).toEqual([
      lock.packages['node_modules/vercel'].version,
      lock.packages['node_modules/vercel'].version,
    ]);
  });

  test('takes the Vercel token as a required secret named vercel-token, and the ids as inputs', () => {
    const call = deploy.on.workflow_call;
    expect([
      call.secrets['vercel-token'].required,
      call.inputs['vercel-project-id'].required,
      call.inputs['vercel-team-id'].required,
      call.inputs['vercel-environment'].default,
    ]).toEqual([true, true, true, 'staging']);
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

  test('the deploy runs on the build stub completing, checks its path, and passes every input the workflow knows', () => {
    const inputs = deploy.on.workflow_call.inputs;
    expect([
      deployStub.on.workflow_run,
      deployJob!.with!['build-workflow'],
      deployJob!.with!['artifact-name'],
      Object.keys(deployJob!.with!).filter((key) => !(key in inputs)),
      Object.keys(deployJob!.secrets!),
    ]).toEqual([
      { workflows: [buildStub.name], types: ['completed'] },
      '.github/workflows/site-build.yml',
      buildJob!.with!['artifact-name'],
      [],
      ['vercel-token'],
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
    [`GET /repos/${REPO}/commits/${SHA}/pulls`]: [pull(17)],
    ...overrides,
  });

  test("deploys this repository's PR build, with the PR number from the API", async () => {
    api = { routes: routes(), calls: [] };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload() });
    expect([result.code, result.outputs]).toEqual([0, { deploy: 'true', pr: '17', 'run-id': '4242', sha: SHA }]);
  });

  test.each<[string, Record<string, unknown>]>([
    ['the PR head moved on', { [`GET /repos/${REPO}/commits/${SHA}/pulls`]: [pull(17, OTHER)] }],
    ['the PR closed', { [`GET /repos/${REPO}/commits/${SHA}/pulls`]: [pull(17, SHA, REPO, 'closed')] }],
    ['two PRs share the head', { [`GET /repos/${REPO}/commits/${SHA}/pulls`]: [pull(17), pull(18)] }],
    ['the PR is from a fork', { [`GET /repos/${REPO}/commits/${SHA}/pulls`]: [pull(17, SHA, 'someone/site')] }],
  ])('skips, without failing, when %s', async (_what, overrides) => {
    api = { routes: routes(overrides), calls: [] };
    const result = await script(['decide', 'preview'], {}, { workflow_run: runPayload() });
    expect([result.code, result.outputs.deploy, result.stdout]).toEqual([
      0,
      'false',
      expect.stringContaining('::notice::'),
    ]);
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

describe('decide: staging', () => {
  const push = () => runPayload({ event: 'push', head_branch: 'main' });
  const routes = (tip: string) => ({
    [`GET /repos/${REPO}/actions/runs/4242`]: push(),
    [`GET /repos/${REPO}/branches/main`]: { commit: { sha: tip } },
  });
  const env = { DEFAULT_BRANCH: 'main', VERCEL_ENVIRONMENT: 'staging' };

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
  ])('refuses %s', async (_what, files, message) => {
    const to = mkdtempSync(join(tmpdir(), 'site-deploy-dir-'));
    const result = await script(['prepare', artifact(files), to], {});
    expect([result.code, result.stderr, readdirSync(to)]).toEqual([1, expect.stringContaining(message), []]);
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

  test('refuses a protected hostname even when it has the preview shape', async () => {
    const result = await alias('marketing-pr-{pr}.vercel.app', '17', 'marketing-pr-17.vercel.app');
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining('is a production or staging hostname')]);
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
    ]).toEqual(['true', 'false', 'false']);
  });

  test('comments the URL on the verified PR, then updates that comment on the next push', async () => {
    const env = { PR: '17', SHA, ARTIFACT_NAME: 'marketing-output', DEPLOYMENT_URL: 'https://x.vercel.app', ALIAS: '' };
    api = { routes: { [`GET /repos/${REPO}/issues/17/comments?per_page=100`]: [] }, calls: [] };
    await script(['comment'], env);
    const posted = api.calls.find((c) => c.method === 'POST')!;
    const body = JSON.parse(posted.body).body as string;
    api = {
      routes: {
        [`GET /repos/${REPO}/issues/17/comments?per_page=100`]: [
          { id: 9, user: { login: 'github-actions[bot]' }, body },
        ],
        [`PATCH /repos/${REPO}/issues/comments/9`]: {},
      },
      calls: [],
    };
    await script(['comment'], { ...env, DEPLOYMENT_URL: 'https://y.vercel.app' });
    expect([posted.path, body.includes('https://x.vercel.app'), api.calls.map((c) => `${c.method} ${c.path}`)]).toEqual(
      [
        `/repos/${REPO}/issues/17/comments`,
        true,
        [`GET /repos/${REPO}/issues/17/comments?per_page=100`, `PATCH /repos/${REPO}/issues/comments/9`],
      ]
    );
  });
});
