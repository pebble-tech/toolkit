import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { OwnershipError } from './errors.js';
import { assertNoSecretsInPlainText } from './secrets.js';
import type { Stage } from './stage.js';

export interface WorkerBucket {
  /** The binding name the script reads, e.g. `UPLOADS`. */
  binding: string;
  /**
   * Prod only: adopt the existing bucket named `<product>-prod-<kind>` (Pulumi's `import` option) instead of creating
   * it. The name is the stage's, never the caller's, so no stack can bind another stage's bucket.
   */
  adoptExisting?: boolean;
}

export interface WorkerArgs {
  stage: Stage;
  /** Cloudflare account id (a plain string: an adopted bucket's import id is built from it). */
  accountId: string;
  /** Zone that holds the hostname. */
  zoneId: pulumi.Input<string>;
  /** The bundled ES module the product's build produced; the component does not bundle. */
  script: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  /** Plain-text bindings. Names that look like secrets are refused unless listed in `plainTextAllowed`. */
  vars?: Record<string, pulumi.Input<string>>;
  /** Secret-text bindings. */
  secrets?: Record<string, pulumi.Input<string>>;
  /** Var names that look like secrets but are not (e.g. a public key). */
  plainTextAllowed?: string[];
  /** An R2 bucket bound to the script, named from the stage. */
  bucket?: WorkerBucket;
  /** `stage.hostname(kind, apex)`; must have the stage's hostname shape. */
  hostname: string;
  /** Name part after `<product>-<env>-`, default `worker`; names the script and the bucket. */
  kind?: string;
  /** Share of requests Workers observability records, from 0 to 1. Default 1: every request. Observability is always on. */
  headSamplingRate?: number;
}

/**
 * A Cloudflare Worker from a prebuilt bundle, with an optional R2 bucket and a custom domain on the zone. Workers
 * observability (logs of each invocation, its errors and exceptions) is on.
 */
export class Worker extends pulumi.ComponentResource {
  readonly scriptName: string;
  readonly bucketName: pulumi.Output<string> | undefined;
  readonly hostname: string;
  readonly url: string;

  constructor(name: string, args: WorkerArgs, opts?: pulumi.ComponentResourceOptions) {
    const { stage } = args;
    stage.requireKind('a Worker', ['preview', 'staging', 'prod']);
    stage.assertOwnsHostname(args.hostname);
    const vars = args.vars ?? {};
    const secrets = args.secrets ?? {};
    assertNoSecretsInPlainText(`Worker ${name}`, vars, args.plainTextAllowed);
    if (args.bucket?.adoptExisting && !stage.isProd) {
      throw new OwnershipError(`Worker ${name}: only prod adopts an existing bucket (this is ${stage.env})`);
    }
    const content = readFileSync(args.script);
    super('pebbletech:index:Worker', name, {}, opts);

    const child = (extra?: pulumi.CustomResourceOptions) => stage.childOptions(this, extra);
    const kind = args.kind ?? 'worker';
    const scriptName = stage.name(kind);
    const bindings: cloudflare.types.input.WorkersScriptBinding[] = [];

    let bucket: cloudflare.R2Bucket | undefined;
    if (args.bucket) {
      const bucketName = stage.name(kind);
      bucket = new cloudflare.R2Bucket(
        `${name}-bucket`,
        { accountId: args.accountId, name: bucketName },
        child(args.bucket.adoptExisting ? { import: `${args.accountId}/${bucketName}/default` } : {})
      );
      bindings.push({ type: 'r2_bucket', name: args.bucket.binding, bucketName: bucket.name });
    }
    for (const [key, text] of Object.entries(vars)) bindings.push({ type: 'plain_text', name: key, text });
    for (const [key, text] of Object.entries(secrets)) {
      bindings.push({ type: 'secret_text', name: key, text: pulumi.secret(text) });
    }

    const script = new cloudflare.WorkersScript(
      name,
      {
        accountId: args.accountId,
        scriptName,
        contentFile: args.script,
        contentSha256: createHash('sha256').update(content).digest('hex'),
        mainModule: basename(args.script),
        compatibilityDate: args.compatibilityDate,
        compatibilityFlags: args.compatibilityFlags ?? [],
        bindings,
        observability: { enabled: true, headSamplingRate: args.headSamplingRate ?? 1 },
      },
      child()
    );
    // A hostname has one custom domain, so a replacement (a new `service`, i.e. a renamed script) must delete the old
    // one first; the default create-first fails on the duplicate. The hostname is unserved for the seconds in between.
    // Never retained, even on prod: a retained domain is only dropped from state, so the delete would not free the
    // hostname. `protect` still guards it on prod.
    new cloudflare.WorkersCustomDomain(
      `${name}-domain`,
      { accountId: args.accountId, zoneId: args.zoneId, hostname: args.hostname, service: script.scriptName },
      { ...child({ deleteBeforeReplace: true }), retainOnDelete: false }
    );

    this.scriptName = scriptName;
    this.bucketName = bucket?.name;
    this.hostname = args.hostname;
    this.url = `https://${args.hostname}`;
    this.registerOutputs({
      scriptName,
      hostname: this.hostname,
      url: this.url,
      ...(bucket ? { bucketName: bucket.name } : {}),
    });
  }
}
