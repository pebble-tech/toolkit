// The decisions and checks site-deploy.yml makes, as one Node script with no dependencies. It runs from the toolkit's
// own checkout (inputs.toolkit-ref), never from the artifact or the caller's repository, and reads only the event
// payload GitHub wrote, the GitHub API and main's workflow inputs: nothing the artifact claims decides anything.
//
//   node site-deploy.mjs decide <preview|staging>   whether to deploy, and the verified run, sha and PR number
//   node site-deploy.mjs prepare <artifact> <dir>   <dir>/.vercel/output from a downloaded artifact, or a refusal
//   node site-deploy.mjs runtime-env <args-file>    masks each RUNTIME_ENV value and writes one `--env` per line
//   node site-deploy.mjs alias                      the preview alias from ALIAS_TEMPLATE, validated, or nothing
//   node site-deploy.mjs recheck                    whether PR is still open with SHA as its head
//   node site-deploy.mjs tip                        whether SHA is still the default branch's tip
//   node site-deploy.mjs deployment-url <file>      the deployment URL, the CLI output's last line, validated
//   node site-deploy.mjs comment                    adds or updates the PR's preview comment
//
// Values come from the environment (GitHub's own variables plus the step's `env:`), so no attacker-controlled text is
// ever part of a command line. Outputs go to $GITHUB_OUTPUT as key=value lines.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

class Refusal extends Error {}

const env = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Refusal(`${name} is not set`);
  }
  return value;
};

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.map((l) => `${l}\n`).join(''));
}

async function github(path, init = {}) {
  const response = await fetch(`${env('GITHUB_API_URL', 'https://api.github.com')}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!response.ok) throw new Refusal(`GitHub API ${init.method ?? 'GET'} ${path}: ${response.status}`);
  return response.json();
}

/**
 * Every page of a list endpoint, 100 at a time, until a page comes back short or `done` says the items so far are
 * enough.
 */
async function all(context, path, done = () => false) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await context.api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100 || done(items)) return items;
  }
}

/** The fields of a workflow run the decision reads, from the event payload or the API: they have the same shape. */
const runFields = (run) => ({
  id: run.id,
  headSha: run.head_sha,
  event: run.event,
  conclusion: run.conclusion,
  path: String(run.path ?? '').replace(/@.*$/, ''),
  headRepository: run.head_repository?.full_name,
});

/**
 * D4, D5, A7, A8: the deploy is for this repository's own build of `expected.path`, finished with success, for a pull
 * request (preview) or a push (staging). The payload's run is trusted (GitHub wrote it); the API's copy must agree,
 * and decides freshness: a preview needs exactly one open PR whose head is the run's sha, and staging needs the sha to
 * be the default branch's tip. A run that is no longer current is skipped, not failed.
 */
export async function decide(kind, event, context) {
  if (kind !== 'preview' && kind !== 'staging') throw new Refusal(`kind must be preview or staging, not ${kind}`);
  const payload = event.workflow_run;
  if (!payload) throw new Refusal('the event is not a workflow_run');
  const run = runFields(payload);
  const wanted = kind === 'preview' ? 'pull_request' : 'push';
  const checks = [
    [run.event === wanted, `the build ran for ${run.event}, not ${wanted}`],
    [run.conclusion === 'success', `the build concluded ${run.conclusion}, not success`],
    [run.path === context.buildWorkflow, `the build workflow is ${run.path}, not ${context.buildWorkflow}`],
    [run.headRepository === context.repository, `the build ran on ${run.headRepository}, not ${context.repository}`],
    [/^[0-9a-f]{40}$/.test(run.headSha ?? ''), 'the build has no head sha'],
    [Number.isSafeInteger(run.id) && run.id > 0, 'the build has no run id'],
  ];
  for (const [ok, message] of checks) if (!ok) throw new Refusal(message);

  const fresh = runFields(await context.api(`/repos/${context.repository}/actions/runs/${run.id}`));
  for (const key of ['headSha', 'event', 'conclusion', 'path', 'headRepository']) {
    if (fresh[key] !== run[key])
      throw new Refusal(`the run's ${key} is ${fresh[key]} in the API, ${run[key]} in the event`);
  }

  const base = { 'run-id': String(run.id), sha: run.headSha };
  if (kind === 'staging') {
    const branch = await context.api(
      `/repos/${context.repository}/branches/${encodeURIComponent(context.defaultBranch)}`
    );
    if (branch.commit?.sha !== run.headSha) {
      return { deploy: 'false', reason: `${run.headSha} is no longer the tip of ${context.defaultBranch}`, ...base };
    }
    return { deploy: 'true', ...base };
  }
  // Every open PR, not the commit's associated PRs: a commit already on the default branch is associated with the PR
  // that merged it, not the open one waiting for a preview. All pages, unless a second match settles it early.
  const eligible = (pr) =>
    pr.state === 'open' &&
    pr.head?.sha === run.headSha &&
    pr.head?.repo?.full_name === context.repository &&
    pr.base?.repo?.full_name === context.repository;
  const open = (
    await all(context, `/repos/${context.repository}/pulls?state=open`, (items) => items.filter(eligible).length > 1)
  ).filter(eligible);
  if (open.length !== 1) {
    return { deploy: 'false', reason: `${open.length} open pull requests have ${run.headSha} as their head`, ...base };
  }
  return { deploy: 'true', pr: String(open[0].number), ...base };
}

/** F6: staging deploys only while `sha` is the default branch's tip, checked again right before `vercel deploy`. */
export async function tip(context, sha) {
  const branch = await context.api(
    `/repos/${context.repository}/branches/${encodeURIComponent(context.defaultBranch)}`
  );
  return branch.commit?.sha === sha;
}

/**
 * The two GitHub environments must differ (each holds its own token and runtime env), and neither may be production's:
 * site-deploy never runs where production secrets live.
 */
export function environments(preview, staging) {
  const names = [
    ['preview-environment', preview],
    ['staging-environment', staging],
  ];
  for (const [what, name] of names) {
    if (!name) throw new Refusal(`${what} is not set`);
    // ASCII only, so no space, tab, zero-width or full-width letter makes production look like another name.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      throw new Refusal(`${what} ${JSON.stringify(name)} is not a plain environment name (letters, digits, _ . -)`);
    }
    if (['prod', 'production'].includes(name.trim().toLowerCase())) {
      throw new Refusal(`${what} is ${name}: site-deploy never runs in production`);
    }
  }
  if (preview.trim().toLowerCase() === staging.trim().toLowerCase()) {
    throw new Refusal(`preview-environment and staging-environment are both ${preview}: each needs its own`);
  }
}

/** D2: the ids main passes must look like Vercel's, so an empty or mistyped variable is a refusal, not a guess. */
export function vercelIds(projectId, teamId) {
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId ?? ''))
    throw new Refusal(`vercel-project-id ${JSON.stringify(projectId ?? '')} is not prj_…`);
  if (!/^team_[A-Za-z0-9]+$/.test(teamId ?? ''))
    throw new Refusal(`vercel-team-id ${JSON.stringify(teamId ?? '')} is not team_…`);
}

/** The deployment URL: the last line `vercel deploy` printed, and only a `https://<name>.vercel.app` URL. */
export function deploymentUrl(text) {
  const last = text.trimEnd().split('\n').at(-1)?.trim() ?? '';
  if (!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(last)) {
    throw new Refusal(`vercel deploy's last line is not a https://<name>.vercel.app URL: ${JSON.stringify(last)}`);
  }
  return last;
}

/** A8: the PR is still open, from this repository, with `sha` as its head, right before an alias or a comment. */
export async function recheck(context, pr, sha) {
  const pull = await context.api(`/repos/${context.repository}/pulls/${pr}`);
  return pull.state === 'open' && pull.head?.sha === sha && pull.head?.repo?.full_name === context.repository;
}

/**
 * A5: copies the artifact's Build Output into `<dir>/.vercel/output`, and nothing else into `<dir>`. Refuses a
 * symlink or anything but a file or directory, a path that leaves the artifact, a `.vercel` directory inside it, a
 * function config that maps files from elsewhere (`filePathMap`) or sets its own `environment`, and an output with no
 * version 3 `config.json`. Leaves out `builds.json` (the build's own report, which `--prebuilt` reads) and the
 * `.vercel` files a project link would use.
 */
export function prepare(artifact, dir) {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Refusal(`${dir} is not empty`);
  const files = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const rel = relative(artifact, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
        throw new Refusal(`${rel} leaves the artifact`);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Refusal(`${rel} is a symlink`);
      if (name === '.vercel') throw new Refusal(`${rel} is a .vercel directory inside the Build Output`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(rel);
      else throw new Refusal(`${rel} is not a file or a directory`);
    }
  };
  walk(artifact);
  const config = files.includes('config.json') ? JSON.parse(readFileSync(join(artifact, 'config.json'), 'utf8')) : {};
  if (config.version !== 3) throw new Refusal('the artifact has no Build Output config.json with version 3');
  const skipped = new Set(['builds.json', 'project.json', 'repo.json', 'README.txt']);
  const kept = files.filter((rel) => !skipped.has(rel));
  for (const rel of kept) {
    if (rel.split(sep).at(-1) !== '.vc-config.json') continue;
    const fn = JSON.parse(readFileSync(join(artifact, rel), 'utf8'));
    for (const key of ['filePathMap', 'environment']) {
      if (fn && typeof fn === 'object' && key in fn) throw new Refusal(`${rel} sets ${key}`);
    }
  }
  const output = join(dir, '.vercel', 'output');
  for (const rel of kept) {
    mkdirSync(join(output, rel, '..'), { recursive: true });
    copyFileSync(join(artifact, rel), join(output, rel));
  }
  return { kept: kept.length, skipped: files.filter((rel) => skipped.has(rel)) };
}

const KEY = /^[A-Z_][A-Z0-9_]*$/;

/**
 * A value as a workflow command carries it: the runner decodes %25, %0D and %0A in `::add-mask::`, so a secret holding
 * a literal `%25` would register the decoded text as the mask. Only the mask is escaped; the argument stays as is.
 */
export const commandValue = (value) => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/** D7: RUNTIME_ENV (a JSON object, secret) and RUNTIME_VARS (plain) as `--env KEY=VALUE` arguments, secrets masked. */
export function runtimeEnv(secretJson, plainJson) {
  const parse = (what, json) => {
    const value = JSON.parse(json || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal(`${what} is not a JSON object`);
    for (const [key, item] of Object.entries(value)) {
      if (!KEY.test(key)) throw new Refusal(`${what} key ${JSON.stringify(key)} is not an env var name`);
      if (typeof item !== 'string' || /[\r\n]/.test(item)) throw new Refusal(`${what}.${key} is not a one-line string`);
    }
    return value;
  };
  const secrets = parse('RUNTIME_ENV', secretJson);
  const plain = parse('runtime-vars', plainJson);
  const both = Object.keys(secrets).filter((key) => key in plain);
  if (both.length) throw new Refusal(`${both.join(', ')} is in both RUNTIME_ENV and runtime-vars`);
  return {
    masks: Object.values(secrets).filter(Boolean),
    args: Object.entries({ ...plain, ...secrets }).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
  };
}

/**
 * D3, A10: the preview alias, `ALIAS_TEMPLATE` with `{pr}` as the verified PR number. It must be
 * `<label>-pr-<n>.vercel.app` for that number, and none of the protected (production and staging) hostnames.
 */
export function previewAlias(template, pr, protectedHosts) {
  if (!template) return '';
  if (!/^[1-9][0-9]*$/.test(pr)) throw new Refusal(`PR number ${pr} is not a number`);
  const alias = template.replaceAll('{pr}', pr);
  if (!new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*-pr-${pr}\\.vercel\\.app$`).test(alias)) {
    throw new Refusal(`alias ${alias} is not <name>-pr-${pr}.vercel.app`);
  }
  const hosts = protectedHosts
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((host) => host.toLowerCase().replace(/\.$/, ''));
  if (hosts.includes(alias)) throw new Refusal(`alias ${alias} is a production or staging hostname`);
  return alias;
}

/** Vercel's protected environment names: site-deploy never deploys to production and previews have their own job. */
export function stagingEnvironment(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || ['production', 'preview', 'development'].includes(name)) {
    throw new Refusal(`vercel-environment ${JSON.stringify(name)} is not a custom environment`);
  }
  return name;
}

const MARKER = (name) => `<!-- pebbletech site-deploy ${name} -->`;

async function comment(context) {
  const pr = env('PR');
  const marker = MARKER(env('ARTIFACT_NAME'));
  const body = [
    marker,
    `**${env('ARTIFACT_NAME')}** preview of ${env('SHA').slice(0, 7)}: ${env('DEPLOYMENT_URL')}`,
    ...(process.env.ALIAS ? [`Alias: https://${process.env.ALIAS}`] : []),
  ].join('\n\n');
  const ours = (c) => c.user?.login === 'github-actions[bot]' && String(c.body).startsWith(marker);
  const comments = await all(context, `/repos/${context.repository}/issues/${pr}/comments`, (items) =>
    items.some(ours)
  );
  const mine = comments.find(ours);
  const path = mine
    ? `/repos/${context.repository}/issues/comments/${mine.id}`
    : `/repos/${context.repository}/issues/${pr}/comments`;
  await context.api(path, { method: mine ? 'PATCH' : 'POST', body: JSON.stringify({ body }) });
}

async function main([command, ...args]) {
  const context = {
    // Only the commands that call the API need it: prepare, runtime-env and alias run without it.
    get repository() {
      return env('GITHUB_REPOSITORY');
    },
    buildWorkflow: process.env.BUILD_WORKFLOW ?? '',
    defaultBranch: process.env.DEFAULT_BRANCH ?? '',
    api: github,
  };
  switch (command) {
    case 'decide': {
      const event = JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8'));
      vercelIds(process.env.VERCEL_PROJECT_ID, process.env.VERCEL_ORG_ID);
      environments(process.env.PREVIEW_ENVIRONMENT, process.env.STAGING_ENVIRONMENT);
      if (args[0] === 'staging') stagingEnvironment(env('VERCEL_ENVIRONMENT'));
      const decision = await decide(args[0], event, context);
      output(decision);
      if (decision.deploy === 'false') process.stdout.write(`::notice::not deployed: ${decision.reason}\n`);
      return;
    }
    case 'prepare': {
      const { kept, skipped } = prepare(args[0], args[1]);
      process.stdout.write(`copied ${kept} files; left out ${skipped.join(', ') || 'nothing'}\n`);
      return;
    }
    case 'runtime-env': {
      const { masks, args: flags } = runtimeEnv(process.env.RUNTIME_ENV, process.env.RUNTIME_VARS);
      for (const mask of masks) process.stdout.write(`::add-mask::${commandValue(mask)}\n`);
      writeFileSync(args[0], flags.map((flag) => `${flag}\n`).join(''));
      return;
    }
    case 'alias':
      output({ alias: previewAlias(process.env.ALIAS_TEMPLATE ?? '', env('PR'), process.env.PROTECTED_HOSTS ?? '') });
      return;
    case 'recheck':
      output({ current: String(await recheck(context, env('PR'), env('SHA'))) });
      return;
    case 'tip':
      output({ current: String(await tip(context, env('SHA'))) });
      return;
    case 'deployment-url':
      output({ url: deploymentUrl(readFileSync(args[0], 'utf8')) });
      return;
    case 'comment':
      await comment(context);
      return;
    default:
      throw new Refusal(`unknown command ${command}`);
  }
}

// The file URL Node gives this module, against the path it was run as (a checkout path may hold a space).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`::error::${error instanceof Refusal ? error.message : error.stack}\n`);
    process.exit(1);
  });
}
