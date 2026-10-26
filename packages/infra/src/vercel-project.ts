import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import * as vercel from '@pulumiverse/vercel';

import { NamespaceError, OwnershipError } from './errors.js';
import { assertNoSecretsInPlainText } from './secrets.js';
import type { Stage } from './stage.js';

/**
 * Which deployments need a Vercel login, spelled as the provider validates `vercel_authentication.deployment_type`
 * (snake case; the SDK's doc comments show camel case, which the provider refuses). `none` is not offered.
 */
export type PreviewProtection = 'only_preview_deployments' | 'standard_protection_new' | 'all_deployments';

/** Project settings, owned by the `shared` stack. */
export interface VercelProjectSettings {
  /** Defaults to `<product>-web`; must start with `<product>-`. */
  name?: string;
  rootDirectory: string;
  buildCommand?: string;
  installCommand?: string;
  devCommand?: string;
  outputDirectory?: string;
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
        const domain = new vercel.ProjectDomain(
          `${name}-domain`,
          { projectId, teamId, domain: hostname, customEnvironmentId: args.customEnvironmentId },
          child({ deleteBeforeReplace: true })
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
