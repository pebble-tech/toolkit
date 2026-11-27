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

/**
 * How long Skew Protection keeps a deployment reachable for the clients it served, as `@pulumiverse/vercel` 5.21.1
 * accepts it (its `skew_protection` validator; the provider sends the seconds as `skewProtectionMaxAge`).
 */
export type SkewProtectionMaxAge = '30 minutes' | '4 hours' | '12 hours' | '1 day' | '7 days';

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
  /**
   * Skew Protection's maximum age: a tab keeps reaching the deployment it loaded from until that deployment is this
   * old. Default `12 hours`, Vercel's default on Pro. `false` turns it off.
   */
  skewProtection?: SkewProtectionMaxAge | false;
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
  /**
   * `prod` only: production hostnames outside the stage shape, such as `new.pebbletech.my` or the apex
   * `pebbletech.my`. See [Custom and apex domains](README.md#custom-and-apex-domains).
   */
  productionDomains?: ProductionDomain[];
}

/** A custom or apex production hostname. */
export interface ProductionDomain {
  /** The zone's apex (`pebbletech.my`) or a name inside it with no hyphen (`new.pebbletech.my`). */
  hostname: string;
  /** The DNS zone's name (`pebbletech.my`). Checked against `zoneId`'s zone when that is given. */
  zoneName: string;
  /**
   * The Cloudflare zone when it is ours: Pulumi makes the unproxied CNAME there (flattened by Cloudflare on the apex).
   * Leave it out for a client's zone: no DNS is made, and `clientDnsRecords` lists the records to add there.
   */
  zoneId?: pulumi.Input<string>;
  /**
   * Make the `_vercel.<zoneName>` TXT record Vercel asks for to verify the hostname, in `zoneId`'s zone. Default
   * false; turn it on when the domain shows a TXT challenge (`verification`). Needs `zoneId`.
   */
  verificationTxt?: boolean;
}

/** A DNS record a client adds in its own zone for a production domain. */
export interface ClientDnsRecord {
  hostname: string;
  type: string;
  name: string;
  value: string;
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
  /**
   * Prod with `productionDomains`: for each hostname, the routing record (a CNAME, or Vercel's A records for an apex in
   * a client's zone) and the TXT challenges Vercel lists for it, to add in a zone Pulumi does not manage.
   */
  readonly clientDnsRecords: pulumi.Output<ClientDnsRecord[]> | undefined;
  /** Prod with `productionDomains`: Vercel's ownership challenges by hostname, empty once a hostname is verified. */
  readonly verification: pulumi.Output<Record<string, vercel.types.output.ProjectDomainVerification[]>> | undefined;

  constructor(name: string, args: VercelProjectArgs, opts?: pulumi.ComponentResourceOptions) {
    const { stage } = args;
    stage.requireKind('a Vercel project or its env', ['shared', 'staging', 'prod']);
    if (stage.isShared) {
      if (!args.project) throw new OwnershipError('the shared stack owns the Vercel project: pass `project`');
      if (args.vars || args.secrets || args.domain || args.productionDomains || args.projectId) {
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
      assertProductionDomains(stage, args);
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
          // Unset is off: the provider sends a max age of 0.
          skewProtection: settings.skewProtection === false ? undefined : (settings.skewProtection ?? '12 hours'),
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
      this.clientDnsRecords = undefined;
      this.verification = undefined;
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
      const production = (args.productionDomains ?? []).map((spec) =>
        productionDomain(name, spec, { projectId, teamId, parent: this, child })
      );
      this.projectId = projectId;
      this.bypassSecret = undefined;
      this.url = args.domain ? `https://${args.domain.hostname}` : undefined;
      this.clientDnsRecords = production.length
        ? pulumi.all(production.map((p) => p.clientDnsRecords)).apply((lists) => lists.flat())
        : undefined;
      this.verification = production.length
        ? pulumi
            .all(production.map((p) => p.verifications.apply((v) => [p.hostname, v ?? []] as const)))
            .apply((entries) => Object.fromEntries(entries))
        : undefined;
    }

    this.registerOutputs({
      projectId: this.projectId,
      customEnvironmentIds: this.customEnvironmentIds,
      ...(this.bypassSecret ? { bypassSecret: this.bypassSecret } : {}),
      ...(this.url ? { url: this.url } : {}),
      ...(this.clientDnsRecords ? { clientDnsRecords: this.clientDnsRecords } : {}),
      ...(this.verification ? { verification: this.verification } : {}),
    });
  }
}

/** Refuses production domains outside `prod`, outside their zone, shaped like a stage hostname, or named twice. */
function assertProductionDomains(stage: Stage, args: VercelProjectArgs): void {
  const domains = args.productionDomains ?? [];
  if (domains.length === 0) return;
  const seen = new Set<string>();
  for (const { hostname, zoneName, zoneId, verificationTxt } of domains) {
    stage.assertCustomHostname(hostname, zoneName);
    if (seen.has(hostname)) throw new NamespaceError(`hostname "${hostname}" is bound twice`);
    seen.add(hostname);
    if (verificationTxt && zoneId === undefined) {
      throw new OwnershipError(`hostname "${hostname}": \`verificationTxt\` makes a record in \`zoneId\`; pass it`);
    }
  }
}

interface DomainContext {
  projectId: pulumi.Output<string>;
  teamId: pulumi.Input<string> | undefined;
  parent: pulumi.Resource;
  child: (extra?: pulumi.CustomResourceOptions) => pulumi.CustomResourceOptions;
}

/**
 * One production hostname: the project domain on `production`, and, in a zone of ours, the unproxied CNAME and the
 * opt-in `_vercel` TXT. Resource names carry the hostname, never a list index, so adding or removing one hostname
 * leaves every other one in place; `${name}-domain` and `${name}-cname` stay the stage domain's.
 */
function productionDomain(name: string, spec: ProductionDomain, context: DomainContext) {
  const { hostname, zoneName } = spec;
  const { projectId, teamId, parent, child } = context;
  const apex = hostname === zoneName;
  // The zone the id names must be the zone the hostname was checked against: a mismatch fails the preview before
  // anything is created, since the domain and its records wait on this check.
  const zoneId =
    spec.zoneId === undefined
      ? undefined
      : pulumi.all([spec.zoneId, cloudflare.getZoneOutput({ zoneId: spec.zoneId }, { parent })]).apply(([id, zone]) => {
          if (zone.name !== zoneName) {
            throw new NamespaceError(
              `zone ${id} is ${zone.name || 'unknown'}, not ${zoneName} (hostname "${hostname}")`
            );
          }
          return id;
        });
  // As the stage domain: replaced delete-first and never retained, so a replacement frees the hostname.
  const domain = new vercel.ProjectDomain(
    `${name}-domain-${hostname}`,
    { projectId, teamId, domain: zoneId ? zoneId.apply(() => hostname) : hostname },
    { ...child({ deleteBeforeReplace: true }), retainOnDelete: false }
  );
  const config = vercel.getDomainConfigOutput(
    { domain: hostname, projectIdOrName: projectId, teamId },
    { parent, dependsOn: [domain] }
  );
  const cname = config.recommendedCname.apply((value) => value.replace(/\.$/, ''));
  if (zoneId) {
    // On the apex Cloudflare flattens the CNAME; the record's name is the zone's full name.
    new cloudflare.DnsRecord(
      `${name}-cname-${hostname}`,
      { zoneId, name: hostname, type: 'CNAME', content: cname, ttl: 1, proxied: false },
      child()
    );
  }
  const txtName = `_vercel.${zoneName}`;
  if (zoneId && spec.verificationTxt) {
    // Vercel lists the challenge until the hostname is verified, then none: the record keeps the value it was made
    // with (`ignoreChanges`), and a hostname with no challenge and not verified is a refusal, not an empty record.
    const content = pulumi.all([domain.verifications, domain.verified]).apply(([challenges, verified]) => {
      const challenge = (challenges ?? []).find((c) => c.type === 'TXT' && c.domain.replace(/\.$/, '') === txtName);
      if (!challenge && !verified) {
        throw new OwnershipError(
          `Vercel lists no ${txtName} TXT challenge for "${hostname}": turn \`verificationTxt\` off`
        );
      }
      return challenge?.value as string;
    });
    new cloudflare.DnsRecord(
      `${name}-vercel-txt-${hostname}`,
      { zoneId, name: txtName, type: 'TXT', content, ttl: 1 },
      child({ ignoreChanges: ['content'] })
    );
  }
  const routing =
    apex && !zoneId
      ? config.recommendedIpv4s.apply((ips) => ips.map((value) => ({ hostname, type: 'A', name: hostname, value })))
      : cname.apply((value) => [{ hostname, type: 'CNAME', name: hostname, value }]);
  const clientDnsRecords = pulumi
    .all([routing, domain.verifications])
    .apply(([records, challenges]) => [
      ...records,
      ...(challenges ?? []).map((c) => ({ hostname, type: c.type, name: c.domain.replace(/\.$/, ''), value: c.value })),
    ]);
  return { hostname, verifications: domain.verifications, clientDnsRecords };
}
