import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import * as vercel from '@pulumiverse/vercel';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NamespaceError, OwnershipError } from './errors.js';
import { assertNoSecretsInPlainText } from './secrets.js';
import type { Stage } from './stage.js';

/**
 * What `shared` deploys once to a new project, shipped in the package: a static page and the `vercel.json` that builds
 * it as one (no install, a no-op build, framework "Other", the directory itself as the output).
 */
const PLACEHOLDER_FILES = ['index.html', 'vercel.json'] as const;
const PLACEHOLDER_DIR = fileURLToPath(new URL('../placeholder/', import.meta.url));

const sha1 = (content: Buffer | string) => createHash('sha1').update(content).digest('hex');

/**
 * The placeholder laid out under the project's root directory, where Vercel builds and reads `vercel.json`, as
 * `vercel.Deployment` takes it: `files` maps a local path to `<size>~<sha1>` (the form `vercel.getFile` gives), and the
 * uploaded name is that path without `pathPrefix`. The provider reads the local files only when it creates the
 * deployment, so they are written under the system's temporary directory, at a path named by their content. Every
 * evaluation on the machine (another product's, a test's) uses the same path, so a file is written once, to a sibling
 * and renamed into place: a reader never sees it part-written.
 */
function placeholderUpload(rootDirectory: string): { files: Record<string, string>; pathPrefix: string } {
  const root = posix.normalize(rootDirectory.replaceAll('\\', '/')).replace(/^(\.\/)+|^\/+|\/+$/g, '') || '.';
  if (root === '..' || root.startsWith('../')) {
    throw new OwnershipError(`rootDirectory "${rootDirectory}" leaves the project`);
  }
  const contents = PLACEHOLDER_FILES.map((file) => [file, readFileSync(join(PLACEHOLDER_DIR, file))] as const);
  // One directory per user: another user's directory under a shared temporary directory is not writable.
  const pathPrefix = join(
    tmpdir(),
    `pebbletech-infra-placeholder-${process.getuid?.() ?? userInfo().username}`,
    sha1([root, ...contents.map(([, c]) => sha1(c))].join('\n'))
  );
  const files: Record<string, string> = {};
  for (const [file, content] of contents) {
    const path = join(pathPrefix, root === '.' ? '' : root, file);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path) || !readFileSync(path).equals(content)) {
      const partial = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
      writeFileSync(partial, content);
      renameSync(partial, path);
    }
    files[path] = `${content.length}~${sha1(content)}`;
  }
  return { files, pathPrefix };
}

/**
 * Which deployments need a Vercel login, spelled as the provider validates `vercel_authentication.deployment_type`
 * (snake case; the SDK's doc comments show camel case, which the provider refuses). `none` is not offered.
 */
export type PreviewProtection = 'only_preview_deployments' | 'standard_protection_new' | 'all_deployments';

/** The Node.js versions `@pulumiverse/vercel` 5.21.1 accepts for a project (its `node_version` validator). */
export type NodeVersion = '18.x' | '20.x' | '22.x' | '24.x';

/** Project settings, owned by the `shared` stack. */
export interface VercelProjectSettings {
  /** Defaults to `<product>-web`; must start with `<product>-`. */
  name?: string;
  rootDirectory: string;
  buildCommand?: string;
  installCommand?: string;
  devCommand?: string;
  outputDirectory?: string;
  /**
   * Node.js for the build and the functions. Default `24.x`, the toolkit's own Node. Without it Vercel gives a new
   * project its own default, which need not be the Node the product declares.
   */
  nodeVersion?: NodeVersion;
  /** Custom environments to create, by name. Default `['staging']`. */
  customEnvironments?: string[];
  /** Default `only_preview_deployments`: previews need a Vercel login (or the bypass secret). */
  protection?: PreviewProtection;
}

export interface VercelProjectArgs {
  stage: Stage;
  /** Vercel team; defaults to the provider's. */
  teamId?: pulumi.Input<string>;
  /** `shared` stack only: the project itself. */
  project?: VercelProjectSettings;
  /** `staging`/`prod`: the shared project's id, from `vercel.getProjectOutput({ name })`. */
  projectId?: pulumi.Input<string>;
  /**
   * `staging`: that project's custom environment id, from `vercel.getCustomEnvironmentOutput`.
   * Prod targets `production`.
   */
  customEnvironmentId?: pulumi.Input<string>;
  /** Plain env vars. Names that look like secrets are refused unless listed in `plainTextAllowed`. */
  vars?: Record<string, pulumi.Input<string>>;
  /** Sensitive env vars: write-only in Vercel. */
  secrets?: Record<string, pulumi.Input<string>>;
  plainTextAllowed?: string[];
  /** The stage's web domain, bound to its environment, with an unproxied CNAME in Cloudflare. */
  domain?: { hostname: string; zoneId: pulumi.Input<string> };
}

/**
 * A Vercel project split by ownership: the `shared` stack owns the project, its custom environments and the
 * protection bypass; `staging` and `prod` own their env vars and domain. Previews own nothing here (they pass env
 * at `vercel deploy`). Deployments stay in the workflow (`vercel build` / `vercel deploy --prebuilt`).
 */
export class VercelProject extends pulumi.ComponentResource {
  /** Shared: the project id. Staging/prod: the id passed in. */
  readonly projectId: pulumi.Output<string>;
  /** Shared: custom environment ids by name. */
  readonly customEnvironmentIds: Record<string, pulumi.Output<string>>;
  /** Shared: the automation bypass secret for protected previews, as a secret. */
  readonly bypassSecret: pulumi.Output<string> | undefined;
  /** Staging/prod: `https://<hostname>` when a domain is bound. */
  readonly url: string | undefined;

  constructor(name: string, args: VercelProjectArgs, opts?: pulumi.ComponentResourceOptions) {
    const { stage } = args;
    stage.requireKind('a Vercel project or its env', ['shared', 'staging', 'prod']);
    if (stage.isShared) {
      if (!args.project) throw new OwnershipError('the shared stack owns the Vercel project: pass `project`');
      if (args.vars || args.secrets || args.domain || args.projectId) {
        throw new OwnershipError('env vars and domains belong to the staging and prod stacks, not shared');
      }
      const projectName = args.project.name ?? `${stage.product}-web`;
      if (!projectName.startsWith(`${stage.product}-`)) {
        throw new NamespaceError(`Vercel project "${projectName}" must start with "${stage.product}-"`);
      }
    } else {
      if (args.project) throw new OwnershipError('only the shared stack owns the Vercel project');
      if (!args.projectId) throw new OwnershipError(`${stage.env} needs \`projectId\` from the shared stack`);
      if (stage.kind === 'staging' && !args.customEnvironmentId) {
        throw new OwnershipError(
          'staging env vars and domain belong to a custom environment: pass `customEnvironmentId`'
        );
      }
      if (args.domain) stage.assertOwnsHostname(args.domain.hostname);
      assertNoSecretsInPlainText(`VercelProject ${name}`, args.vars ?? {}, args.plainTextAllowed);
    }
    super('pebbletech:index:VercelProject', name, {}, opts);

    const child = (extra?: pulumi.CustomResourceOptions) => stage.childOptions(this, extra);
    const teamId = args.teamId;
    this.customEnvironmentIds = {};

    if (args.project) {
      const settings = args.project;
      const project = new vercel.Project(
        name,
        {
          name: settings.name ?? `${stage.product}-web`,
          teamId,
          rootDirectory: settings.rootDirectory,
          buildCommand: settings.buildCommand,
          installCommand: settings.installCommand,
          devCommand: settings.devCommand,
          outputDirectory: settings.outputDirectory,
          nodeVersion: settings.nodeVersion ?? '24.x',
          publicSource: false,
          vercelAuthentication: { deploymentType: settings.protection ?? 'only_preview_deployments' },
        },
        child()
      );
      for (const environment of settings.customEnvironments ?? ['staging']) {
        const custom = new vercel.CustomEnvironment(
          `${name}-${environment}`,
          { projectId: project.id, teamId, name: environment },
          child()
        );
        this.customEnvironmentIds[environment] = custom.id;
      }
      const bypass = new vercel.ProjectProtectionBypass(
        `${name}-bypass`,
        { projectId: project.id, teamId, note: 'CI smoke tests and preview checks' },
        child()
      );
      // A deployment that names no target is the project's production deployment when the project has none yet, and a
      // preview otherwise (the Vercel CLI: "This is your project's first deployment, so it was assigned to
      // production"). So a new project's first deployment is this static page, never a pull request's preview; on a
      // project that already has a production deployment it is one more preview, behind Vercel Authentication, and
      // production is untouched. Its own `vercel.json` turns the project's install and build off for this deployment
      // only. No `projectSettings`: the provider drops empty commands from them, and Vercel saves a first deployment's
      // `projectSettings` for the next ones. Created once: its inputs are ignored afterwards, so neither another
      // temporary directory nor a new page makes a new deployment.
      new vercel.Deployment(
        `${name}-placeholder`,
        { projectId: project.id, teamId, ...placeholderUpload(settings.rootDirectory) },
        child({ ignoreChanges: ['files', 'pathPrefix', 'production'] })
      );
      this.projectId = project.id;
      this.bypassSecret = pulumi.secret(bypass.secret);
      this.url = undefined;
    } else {
      const projectId = pulumi.output(args.projectId!);
      const scope = args.customEnvironmentId
        ? { customEnvironmentIds: [args.customEnvironmentId] }
        : { targets: ['production'] };
      const variables = [
        ...Object.entries(args.vars ?? {}).map(([key, value]) => ({ key, value, sensitive: false })),
        ...Object.entries(args.secrets ?? {}).map(([key, value]) => ({
          key,
          value: pulumi.secret(value),
          sensitive: true,
        })),
      ];
      for (const variable of variables) {
        new vercel.ProjectEnvironmentVariable(
          `${name}-env-${variable.key}`,
          { projectId, teamId, ...variable, ...scope },
          child()
        );
      }
      if (args.domain) {
        const { hostname, zoneId } = args.domain;
        // A hostname is on one project and the provider adds a domain rather than moving it, so a replacement (a new
        // `projectId`) must remove it from the old project first. The hostname is unserved for the seconds in between.
        // Never retained, even on prod: a retained domain is only dropped from state, so the delete would not free the
        // hostname. `protect` still guards it on prod.
        const domain = new vercel.ProjectDomain(
          `${name}-domain`,
          { projectId, teamId, domain: hostname, customEnvironmentId: args.customEnvironmentId },
          { ...child({ deleteBeforeReplace: true }), retainOnDelete: false }
        );
        const config = vercel.getDomainConfigOutput(
          { domain: hostname, projectIdOrName: projectId, teamId },
          { parent: this, dependsOn: [domain] }
        );
        new cloudflare.DnsRecord(
          `${name}-cname`,
          {
            zoneId,
            name: hostname,
            type: 'CNAME',
            content: config.recommendedCname.apply((cname) => cname.replace(/\.$/, '')),
            ttl: 1,
            proxied: false,
          },
          child()
        );
      }
      this.projectId = projectId;
      this.bypassSecret = undefined;
      this.url = args.domain ? `https://${args.domain.hostname}` : undefined;
    }

    this.registerOutputs({
      projectId: this.projectId,
      customEnvironmentIds: this.customEnvironmentIds,
      ...(this.bypassSecret ? { bypassSecret: this.bypassSecret } : {}),
      ...(this.url ? { url: this.url } : {}),
    });
  }
}
