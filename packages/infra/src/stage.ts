import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { NamespaceError, OwnershipError, StageError } from './errors.js';

/** `pr-<n>` for a pull-request preview, `staging`, `prod`, or `shared` for the stack that owns cross-stage resources. */
export type StageEnv = 'staging' | 'prod' | 'shared' | `pr-${number}`;

/** Which stages a component may run in. `preview` stands for every `pr-<n>` stack. */
export type StageKind = 'preview' | 'staging' | 'prod' | 'shared';

export interface StageArgs {
  /** Product id, lowercase kebab case (`base`, `basefresh`). The `pebble` prefix is reserved for shared infrastructure. */
  product: string;
  /** Pulumi stack name; defaults to the running stack. */
  stack?: string;
}

/** What a child resource gets on prod (and on `shared`, which owns production's Vercel project). */
export interface RemovalPolicy {
  protect: boolean;
  retainOnDelete: boolean;
}

/** Which deploy role serves a stage: one `preview` role covers every `pr-<n>` stack. */
export type DeployEnv = 'preview' | 'staging' | 'prod';

declare const boundaryBrand: unique symbol;

/**
 * A permissions boundary ARN. Only `Stage.permissionsBoundaryArn()` and `DeployRole.boundaryArn` produce one; a
 * plain string does not type-check, and any other value is refused when it resolves.
 */
export type PermissionsBoundaryArn = pulumi.Output<string> & { readonly [boundaryBrand]: true };

/** Name of the permissions boundary policy a deploy env's roles carry; `DeployRole` creates it. */
export function boundaryPolicyName(product: string, env: DeployEnv): string {
  return `${product}-${env}-boundary`;
}

/** Where a deploy env's Pulumi state lives and which key encrypts its secrets (the shared bootstrap creates both). */
export interface DeployState {
  bucket: string;
  /** Key prefixes in the bucket; staging also owns `<product>/shared`, since its role applies the shared stack. */
  paths: string[];
  kmsAlias: string;
}

/** State location for a product and deploy env: `pebble-<stg|prd>-pulumi-state/<product>/<env>`. */
export function deployState(product: string, env: DeployEnv): DeployState {
  const account = env === 'prod' ? 'prd' : 'stg';
  return {
    bucket: `pebble-${account}-pulumi-state`,
    paths: env === 'staging' ? [`${product}/staging`, `${product}/shared`] : [`${product}/${env}`],
    kmsAlias: `alias/pebble-${account}-pulumi-${env}`,
  };
}

/** The GitHub environment whose OIDC tokens a deploy env's role trusts. */
export function githubEnvironment(env: DeployEnv): string {
  return env === 'prod' ? 'production' : env;
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PREVIEW = /^pr-([1-9][0-9]*)$/;

/** Throws StageError unless `product` is a kebab-case id outside the reserved `pebble` prefix. */
export function assertProduct(product: string): void {
  if (!SLUG.test(product)) {
    throw new StageError(`product id "${product}" must be lowercase kebab case, e.g. "basefresh"`);
  }
  // A segment like `staging` or `pr` would let one product's names fall inside another's `<product>-<env>-*` scope.
  if (product.split('-').some((segment) => ['pr', 'staging', 'prod', 'shared'].includes(segment))) {
    throw new StageError(`product id "${product}" contains an env word (pr, staging, prod, shared) as a segment`);
  }
  if (product.startsWith('pebble')) {
    throw new StageError(`product id "${product}" starts with "pebble", which is reserved for shared infrastructure`);
  }
}

function parseEnv(stack: string): { env: StageEnv; kind: StageKind; pr?: number } {
  if (stack === 'staging' || stack === 'prod' || stack === 'shared') return { env: stack, kind: stack };
  const preview = PREVIEW.exec(stack);
  if (preview) return { env: stack as StageEnv, kind: 'preview', pr: Number(preview[1]) };
  throw new StageError(`stack "${stack}" is not one of pr-<n>, staging, prod or shared`);
}

function assertSlug(what: string, value: string): void {
  if (!SLUG.test(value)) throw new NamespaceError(`${what} "${value}" must be lowercase kebab case`);
}

/**
 * The stage a product stack deploys: product id plus env, parsed from the stack name.
 * Every other component takes a Stage and names, tags and protects what it creates through it.
 */
export class Stage extends pulumi.ComponentResource {
  readonly product: string;
  readonly env: StageEnv;
  readonly kind: StageKind;
  /** The pull-request number on a preview stack. */
  readonly pr: number | undefined;
  readonly isPreview: boolean;
  readonly isProd: boolean;
  readonly isShared: boolean;
  /** `protect` and `retainOnDelete` for every child resource: on for prod and shared. */
  readonly removalPolicy: RemovalPolicy;
  /** Tags for every AWS resource. The deploy role's conditions read `product` and `env`. */
  readonly tags: Readonly<Record<string, string>>;

  constructor(name: string, args: StageArgs, opts?: pulumi.ComponentResourceOptions) {
    assertProduct(args.product);
    const parsed = parseEnv(args.stack ?? pulumi.getStack());
    super('pebbletech:index:Stage', name, {}, opts);

    this.product = args.product;
    this.env = parsed.env;
    this.kind = parsed.kind;
    this.pr = parsed.pr;
    this.isPreview = parsed.kind === 'preview';
    this.isProd = parsed.kind === 'prod';
    this.isShared = parsed.kind === 'shared';
    const retain = this.isProd || this.isShared;
    this.removalPolicy = { protect: retain, retainOnDelete: retain };
    this.tags = { product: this.product, env: this.env, 'managed-by': 'pulumi' };

    this.registerOutputs({ product: this.product, env: this.env, namespace: this.name() });
  }

  /** `<product>-<env>[-kind][-suffix]`: the only shape a product resource name may take. */
  name(kind?: string, suffix?: string): string {
    if (kind !== undefined) assertSlug('kind', kind);
    if (suffix !== undefined) assertSlug('suffix', suffix);
    return [this.product, this.env, kind, suffix].filter(Boolean).join('-');
  }

  /** Legacy suffix for hostnames: `stg` on staging, none on prod, `pr-<n>` on previews. */
  get domainSuffix(): string {
    this.requireKind('a hostname', ['preview', 'staging', 'prod']);
    if (this.isProd) return '';
    return this.kind === 'staging' ? 'stg' : this.env;
  }

  /** `<kind>-<product>[-<suffix>].<apex>`, e.g. `api-base-stg.pebbletech.my` on staging, `api-base.pebbletech.my` on prod. */
  hostname(kind: string, apex: string): string {
    assertSlug('kind', kind);
    const suffix = this.domainSuffix;
    return `${kind}-${this.product}${suffix ? `-${suffix}` : ''}.${apex}`;
  }

  /** Throws NamespaceError unless `hostname` has this stage's shape (`<kind>-<product>[-<suffix>].<apex>`). */
  assertOwnsHostname(hostname: string): void {
    const suffix = this.domainSuffix;
    const label = hostname.split('.')[0] ?? '';
    const own = new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*-${this.product}${suffix ? `-${suffix}` : ''}$`);
    if (hostname.split('.').length < 3 || !own.test(label)) {
      throw new NamespaceError(
        `hostname "${hostname}" is not in ${this.name()}'s namespace; expected <kind>-${this.product}${suffix ? `-${suffix}` : ''}.<apex>`
      );
    }
  }

  /** Postgres database name: `<product>_stg`, `<product>_prd` or `<product>_pr_<n>`, dashes as underscores. */
  databaseName(): string {
    this.requireKind('a database', ['preview', 'staging', 'prod']);
    const suffix = this.isProd ? 'prd' : this.kind === 'staging' ? 'stg' : `pr_${this.pr}`;
    return `${this.product.replaceAll('-', '_')}_${suffix}`;
  }

  /** The deploy role that serves this stage. `shared` has none of its own (staging's role applies it). */
  get deployEnv(): DeployEnv {
    this.requireKind('an IAM role', ['preview', 'staging', 'prod']);
    return this.isPreview ? 'preview' : this.isProd ? 'prod' : 'staging';
  }

  /** `arn:aws:iam::<account>:policy/<product>-<deploy env>-boundary` in the account the AWS provider points at. */
  permissionsBoundaryArn(): PermissionsBoundaryArn {
    const { accountId } = aws.getCallerIdentityOutput({}, { parent: this });
    const name = boundaryPolicyName(this.product, this.deployEnv);
    return pulumi.interpolate`arn:aws:iam::${accountId}:policy/${name}` as PermissionsBoundaryArn;
  }

  /** Throws OwnershipError when `what` may not be created in this stage. */
  requireKind(what: string, kinds: readonly StageKind[]): void {
    if (!kinds.includes(this.kind)) {
      throw new OwnershipError(`${what} cannot be created in the ${this.env} stack (allowed: ${kinds.join(', ')})`);
    }
  }

  /** Options for a component's child: parented to it, and protected and retained when the stage says so. */
  childOptions<T extends pulumi.CustomResourceOptions>(
    parent: pulumi.Resource,
    extra?: T
  ): T & pulumi.CustomResourceOptions {
    const { protect, retainOnDelete } = this.removalPolicy;
    return {
      ...extra,
      parent,
      ...(protect ? { protect } : {}),
      ...(retainOnDelete ? { retainOnDelete } : {}),
    } as T & pulumi.CustomResourceOptions;
  }
}
