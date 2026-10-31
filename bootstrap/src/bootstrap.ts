import { deployAccount, stateBucketName, stateKeyAlias, type DeployAccount, type DeployEnv } from '@pebbletech/infra';
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

/** GitHub's OIDC issuer; AWS allows one provider per URL per account. */
export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
/** The thumbprints SST's bootstrap registered (base-app `infra/bootstrap/sst.config.ts`); an import must match them. */
export const GITHUB_OIDC_THUMBPRINTS = [
  '6938fd4d98bab03faadb97b34396831e3780aea1',
  '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
];

/** Days S3 keeps a superseded state file before expiring it. */
export const NONCURRENT_STATE_DAYS = 30;

export interface BootstrapSettings {
  /** The stack name: one stack per AWS account. */
  account: DeployAccount;
  /** The 12-digit account the stack must run in; the AWS provider refuses credentials for any other account. */
  accountId: string;
  region: string;
  /** Adopt the account's existing GitHub OIDC provider instead of creating it. */
  importOidcProvider: boolean;
}

/** What the entry point passes besides the checked settings: the address the account's alarm topic emails. */
export interface BootstrapArgs extends BootstrapSettings {
  /** From stack config `alarmEmail`, read as a secret: this repository is public. */
  alarmEmail: pulumi.Input<string>;
}

/** Every state key the bootstrap creates in an account: one per deploy env there. */
export function stateKeys(account: DeployAccount): DeployEnv[] {
  return (['preview', 'staging', 'prod'] as const).filter((env) => deployAccount(env) === account);
}

/** Checks the stack name and config the entry point read; throws on anything the program cannot run with. */
export function settings(
  stack: string,
  config: { accountId: string; region: string; oidc?: { import?: unknown } }
): BootstrapSettings {
  if (stack !== 'stg' && stack !== 'prd') {
    throw new Error(`pebble-aws-bootstrap stacks are stg and prd, one per AWS account (got "${stack}")`);
  }
  if (!/^[0-9]{12}$/.test(config.accountId)) {
    throw new Error(`accountId "${config.accountId}" is not a 12-digit AWS account id`);
  }
  const importFlag = config.oidc?.import ?? false;
  if (typeof importFlag !== 'boolean') throw new Error('oidc.import must be true or false');
  return { account: stack, accountId: config.accountId, region: config.region, importOidcProvider: importFlag };
}

const keep = { protect: true, retainOnDelete: true } as const;
const tags = { 'managed-by': 'pulumi', project: 'pebble-aws-bootstrap' };

/** Key policy that leaves the key to the account's IAM policies (the AWS default, written out). */
function accountAdmin(accountId: string) {
  return {
    Sid: 'AccountIamManagesKey',
    Effect: 'Allow',
    Principal: { AWS: `arn:aws:iam::${accountId}:root` },
    Action: 'kms:*',
    Resource: '*',
  };
}

export interface StateKeyArgs {
  key: DeployEnv;
  accountId: string;
}

/** A KMS key for Pulumi secrets and its alias, named as `DeployRole` looks it up. */
export class PulumiStateKey extends pulumi.ComponentResource {
  readonly aliasName: string;
  readonly aliasArn: pulumi.Output<string>;
  readonly keyArn: pulumi.Output<string>;

  constructor(name: string, args: StateKeyArgs, opts?: pulumi.ComponentResourceOptions) {
    super('pebbletech:bootstrap:PulumiStateKey', name, {}, opts);
    this.aliasName = stateKeyAlias(args.key);

    const key = new aws.kms.Key(
      `${name}-key`,
      {
        description: `Pulumi secrets for ${args.key} stacks`,
        enableKeyRotation: true,
        deletionWindowInDays: 30,
        policy: JSON.stringify({ Version: '2012-10-17', Statement: [accountAdmin(args.accountId)] }),
        tags: { ...tags, 'state-key': args.key },
      },
      { parent: this, ...keep }
    );
    const alias = new aws.kms.Alias(
      `${name}-alias`,
      { name: this.aliasName, targetKeyId: key.keyId },
      { parent: this, ...keep }
    );

    this.aliasArn = alias.arn;
    this.keyArn = key.arn;
    this.registerOutputs({ aliasName: this.aliasName, aliasArn: this.aliasArn, keyArn: this.keyArn });
  }
}

export interface StateBucketArgs {
  account: DeployAccount;
  accountId: string;
  region: string;
}

/**
 * The account's Pulumi state bucket: versioned, private, SSE-KMS under its own key with S3 Bucket Keys on, and
 * superseded state files kept 30 days.
 */
export class PulumiStateBucket extends pulumi.ComponentResource {
  readonly bucketName: string;
  readonly bucketArn: pulumi.Output<string>;
  readonly keyArn: pulumi.Output<string>;

  constructor(name: string, args: StateBucketArgs, opts?: pulumi.ComponentResourceOptions) {
    super('pebbletech:bootstrap:PulumiStateBucket', name, {}, opts);
    this.bucketName = stateBucketName(args.account);
    const child = { parent: this, ...keep };

    // Deploy roles get S3 access by state path, not KMS access to this key: any principal in the account may use it
    // through S3 only, as the AWS-managed aws/s3 key allows.
    const key = new aws.kms.Key(
      `${name}-key`,
      {
        description: `Encrypts ${this.bucketName}`,
        enableKeyRotation: true,
        deletionWindowInDays: 30,
        policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            accountAdmin(args.accountId),
            {
              Sid: 'AccountUsesKeyThroughS3',
              Effect: 'Allow',
              Principal: { AWS: '*' },
              Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
              Resource: '*',
              Condition: {
                StringEquals: {
                  'kms:CallerAccount': args.accountId,
                  'kms:ViaService': `s3.${args.region}.amazonaws.com`,
                },
              },
            },
          ],
        }),
        tags,
      },
      child
    );
    new aws.kms.Alias(`${name}-key-alias`, { name: `alias/${this.bucketName}`, targetKeyId: key.keyId }, child);

    const bucket = new aws.s3.Bucket(name, { bucket: this.bucketName, tags }, child);
    new aws.s3.BucketPublicAccessBlock(
      name,
      {
        bucket: bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      child
    );
    new aws.s3.BucketServerSideEncryptionConfiguration(
      name,
      {
        bucket: bucket.id,
        rules: [
          {
            applyServerSideEncryptionByDefault: { sseAlgorithm: 'aws:kms', kmsMasterKeyId: key.arn },
            bucketKeyEnabled: true,
          },
        ],
      },
      child
    );
    const versioning = new aws.s3.BucketVersioning(
      name,
      { bucket: bucket.id, versioningConfiguration: { status: 'Enabled' } },
      child
    );
    new aws.s3.BucketLifecycleConfiguration(
      name,
      {
        bucket: bucket.id,
        rules: [
          {
            id: 'expire-superseded-state',
            status: 'Enabled',
            filter: { prefix: '' },
            noncurrentVersionExpiration: { noncurrentDays: NONCURRENT_STATE_DAYS },
          },
        ],
      },
      { ...child, dependsOn: [versioning] }
    );

    this.bucketArn = bucket.arn;
    this.keyArn = key.arn;
    this.registerOutputs({ bucketName: this.bucketName, bucketArn: this.bucketArn, keyArn: this.keyArn });
  }
}

/** `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`, the id an import adopts. */
export function githubOidcProviderArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:oidc-provider/${new URL(GITHUB_OIDC_URL).host}`;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The configured alarm address, refused (without printing it) unless it looks like one. */
function alarmAddress(value: string): string {
  if (!EMAIL.test(value)) {
    throw new Error(
      'alarmEmail is not an email address: set it with `pulumi config set --secret alarmEmail <address>`'
    );
  }
  return value;
}

/**
 * One account's shared bootstrap: the GitHub OIDC provider every deploy role trusts, the Pulumi state bucket, the
 * state KMS keys, and the SNS topic products' alarms notify. Nothing here belongs to a product; each product's
 * `DeployRole` derives these names, and each product passes `alarmTopicArn` to its `ApiFunction`s.
 */
export function bootstrap(args: BootstrapArgs) {
  const provider = new aws.Provider('aws', { region: args.region, allowedAccountIds: [args.accountId] });

  const oidc = new aws.iam.OpenIdConnectProvider(
    'github-actions',
    { url: GITHUB_OIDC_URL, clientIdLists: ['sts.amazonaws.com'], thumbprintLists: GITHUB_OIDC_THUMBPRINTS },
    {
      provider,
      ...keep,
      // SST may have tagged the provider; an import fails on any input that differs from what exists.
      ignoreChanges: ['tags', 'tagsAll'],
      ...(args.importOidcProvider ? { import: githubOidcProviderArn(args.accountId) } : {}),
    }
  );

  const bucket = new PulumiStateBucket('state', args, { providers: [provider] });
  const keys = stateKeys(args.account).map(
    (key) =>
      [key, new PulumiStateKey(`state-${key}`, { key, accountId: args.accountId }, { providers: [provider] })] as const
  );

  // Unencrypted, under SNS's default access policy, which lets CloudWatch alarms in this account publish. A KMS key
  // would need a key policy that lets cloudwatch.amazonaws.com use it (alias/aws/sns does not), or alarms fail
  // silently; a notification holds an alarm's name and state, nothing secret.
  const alarms = new aws.sns.Topic('alarms', { name: `pebble-${args.account}-alarms`, tags }, { provider, ...keep });
  // Not protected or retained: a new address replaces the subscription. Only a confirmed old address is unsubscribed;
  // SNS refuses to delete a pending one, which stays for up to 48 hours and can still be confirmed (README: "Change the
  // alarm address"). AWS emails the address a confirmation link; nothing is delivered until its owner clicks it.
  new aws.sns.TopicSubscription(
    'alarms-email',
    { topic: alarms.arn, protocol: 'email', endpoint: pulumi.output(args.alarmEmail).apply(alarmAddress) },
    { provider }
  );

  return {
    oidcProviderArn: oidc.arn,
    alarmTopicArn: alarms.arn,
    stateBucket: bucket.bucketName,
    keyAliasArns: Object.fromEntries(keys.map(([key, stateKey]) => [key, stateKey.aliasArn])),
  };
}
