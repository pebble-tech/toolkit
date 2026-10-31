import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { StageError } from './errors.js';
import {
  assertProduct,
  boundaryPolicyName,
  type DeployEnv,
  deployState,
  githubEnvironment,
  type PermissionsBoundaryArn,
} from './stage.js';

const BASIC_EXECUTION = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

/** One DNS label in a zone name: letters, digits and hyphens, not starting or ending with a hyphen. */
const APEX_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Throws StageError unless `apex` is a zone name of lowercase labels with no leading or trailing dot. */
function assertApex(apex: string): void {
  const labels = apex.split('.');
  if (labels.some((label) => !APEX_LABEL.test(label))) {
    throw new StageError(
      `apex "${apex}" must be a registered zone name: lowercase labels separated by dots, no leading or trailing dot`
    );
  }
}

export interface DeployRoleArgs {
  product: string;
  /** The stacks this role deploys: `preview` covers every `pr-<n>` stack. */
  env: DeployEnv;
  /** Registered zone name. Staging and prod domain globs end with this literal. */
  apex: string;
  /** The product's repository. The trusted GitHub environment comes from `env` (`preview`, `staging`, `production`). */
  github: { org: string; repo: string };
}

type Statement = Record<string, unknown>;

/**
 * The role a product's GitHub workflow assumes for one env, plus the permissions boundary every role it creates must
 * carry. Applied by hand once per product and env from the product's `infra/bootstrap` stack. Everything that ties it
 * to an env (trusted GitHub environment, OIDC provider, state bucket and paths, KMS key) is derived from `product` and
 * `env`, so a role cannot be pointed at another env's state or tokens. Domain globs end with the given `apex`. A `preview`
 * role deploys only `pr-<n>` stacks
 * (a database and a SQL role on PlanetScale), so its policy is the state path and its KMS key. `staging` and `prod`
 * also manage AWS resources named `<product>-<env>-*`, CloudWatch alarms included.
 */
export class DeployRole extends pulumi.ComponentResource {
  readonly roleArn: pulumi.Output<string>;
  readonly roleName: string;
  readonly boundaryArn: PermissionsBoundaryArn;
  readonly boundaryName: string;

  constructor(name: string, args: DeployRoleArgs, opts?: pulumi.ComponentResourceOptions) {
    assertProduct(args.product);
    assertApex(args.apex);
    super('pebbletech:index:DeployRole', name, {}, opts);

    const { product, env, apex } = args;
    const scope = env === 'preview' ? `${product}-pr-*` : `${product}-${env}-*`;
    const roleName = `${product}-${env}-deploy`;
    const boundaryName = boundaryPolicyName(product, env);
    const tags = { product, env, 'managed-by': 'pulumi' };
    const retain = env === 'prod';
    const child = (extra?: pulumi.CustomResourceOptions): pulumi.CustomResourceOptions => ({
      ...extra,
      parent: this,
      ...(retain ? { protect: true, retainOnDelete: true } : {}),
    });

    // What a workload role may ever do: write its own Lambda logs. Roles the deploy role creates must carry it.
    const boundary = new aws.iam.Policy(
      `${name}-boundary`,
      {
        name: boundaryName,
        description: `Permissions boundary for ${scope} workload roles`,
        policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              Resource: [
                `arn:aws:logs:*:*:log-group:/aws/lambda/${scope}`,
                `arn:aws:logs:*:*:log-group:/aws/lambda/${scope}:*`,
              ],
            },
          ],
        }),
        tags,
      },
      child()
    );

    const { accountId } = aws.getCallerIdentityOutput({}, { parent: this });
    const oidcProviderArn = pulumi.interpolate`arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`;
    const state = deployState(product, env);
    const kmsKeyArn = aws.kms.getAliasOutput({ name: state.kmsAlias }, { parent: this }).targetKeyArn;
    const subs = [`repo:${args.github.org}/${args.github.repo}:environment:${githubEnvironment(env)}`];
    const role = new aws.iam.Role(
      `${name}-role`,
      {
        name: roleName,
        description: `GitHub Actions deploy for ${args.github.org}/${args.github.repo} (${product} ${env})`,
        assumeRolePolicy: pulumi.jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Federated: oidcProviderArn },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub': subs,
                },
              },
            },
          ],
        }),
        tags,
      },
      child()
    );

    const { bucket, paths } = state;
    const roles = `arn:aws:iam::*:role/${scope}`;
    const tagged = (prefix: 'aws:RequestTag' | 'aws:ResourceTag') => ({
      StringLike: { [`${prefix}/product`]: product, [`${prefix}/env`]: env },
    });
    const stateStatements = (kmsKeyArn: string): Statement[] => [
      {
        Sid: 'StateList',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: { StringLike: { 's3:prefix': paths.flatMap((path) => [path, `${path}/*`]) } },
      },
      {
        Sid: 'StateObjects',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: paths.map((path) => `arn:aws:s3:::${bucket}/${path}/*`),
      },
      {
        Sid: 'StateSecrets',
        Effect: 'Allow',
        Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        Resource: kmsKeyArn,
      },
    ];
    const statements = (boundaryArn: string, kmsKeyArn: string): Statement[] => {
      const stateOnly = stateStatements(kmsKeyArn);
      if (env === 'preview') return stateOnly;
      // Hostname suffix Stage.domainSuffix uses: `stg` on staging, none on prod (`<kind>-<product>[-stg].<apex>`).
      // The apex is literal. `*` still matches a dot, so a name in a sub-zone of the apex whose label ends with
      // `-<product>[-stg]` matches too.
      const domainSuffix = env === 'staging' ? 'stg' : '';
      const domainNames = `arn:aws:apigateway:*::/domainnames/*-${product}${domainSuffix ? `-${domainSuffix}` : ''}.${apex}`;
      // The domain glob ends at the apex, so it does not cover Create/Get/Update/DeleteApiMapping.
      const domainResources = [domainNames, `${domainNames}/apimappings`, `${domainNames}/apimappings/*`];
      const apiName = `${product}-${env}-*`;
      const httpApi: Statement[] = [
        {
          Sid: 'HttpApiCreate',
          Effect: 'Allow',
          Action: 'apigateway:POST',
          Resource: 'arn:aws:apigateway:*::/apis',
          Condition: { StringLike: { 'apigateway:Request/ApiName': apiName } },
        },
        {
          // Resource/ApiName is on the API and absent on routes, integrations and stages, so IfExists lets those
          // through. Request/ApiName is present on UpdateApi when the request sets Name, so a rename stays inside
          // <product>-<env>-*. Residual: an edit under another API's id still succeeds.
          Sid: 'HttpApi',
          Effect: 'Allow',
          Action: [
            'apigateway:GET',
            'apigateway:POST',
            'apigateway:PUT',
            'apigateway:PATCH',
            'apigateway:DELETE',
            'apigateway:TagResource',
            'apigateway:UntagResource',
          ],
          Resource: 'arn:aws:apigateway:*::/apis/*',
          Condition: {
            StringLikeIfExists: {
              'apigateway:Resource/ApiName': apiName,
              'apigateway:Request/ApiName': apiName,
            },
          },
        },
        {
          Sid: 'HttpApiDomainCreate',
          Effect: 'Allow',
          Action: 'apigateway:POST',
          Resource: 'arn:aws:apigateway:*::/domainnames',
        },
        {
          // POST on `/apimappings` is CreateApiMapping; GET, PATCH and DELETE on `/apimappings/*` are the read,
          // update and delete. The same actions also cover the domain name itself.
          Sid: 'HttpApiDomain',
          Effect: 'Allow',
          Action: ['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'],
          Resource: domainResources,
        },
        // No /tags/* grant. The API Gateway V2 reference does not list aws:ResourceTag/${TagKey} for
        // TagResource or UntagResource. CreateApi still sends tags; a later tag update is denied.
      ];
      return [
        {
          Sid: 'Lambda',
          Effect: 'Allow',
          Action: [
            'lambda:CreateFunction',
            'lambda:DeleteFunction',
            'lambda:Get*',
            'lambda:List*',
            'lambda:Update*',
            'lambda:PublishVersion',
            'lambda:AddPermission',
            'lambda:RemovePermission',
            'lambda:PutFunctionConcurrency',
            'lambda:DeleteFunctionConcurrency',
            'lambda:TagResource',
            'lambda:UntagResource',
          ],
          Resource: `arn:aws:lambda:*:*:function:${scope}`,
        },
        ...httpApi,
        {
          Sid: 'CertificatesRead',
          Effect: 'Allow',
          Action: ['acm:DescribeCertificate', 'acm:ListCertificates', 'acm:ListTagsForCertificate'],
          Resource: '*',
        },
        {
          Sid: 'CertificatesCreateTagged',
          Effect: 'Allow',
          Action: ['acm:RequestCertificate', 'acm:AddTagsToCertificate'],
          Resource: '*',
          Condition: tagged('aws:RequestTag'),
        },
        {
          Sid: 'CertificatesChangeOwn',
          Effect: 'Allow',
          Action: ['acm:DeleteCertificate', 'acm:RemoveTagsFromCertificate'],
          Resource: '*',
          Condition: tagged('aws:ResourceTag'),
        },
        {
          Sid: 'Logs',
          Effect: 'Allow',
          Action: [
            'logs:CreateLogGroup',
            'logs:DeleteLogGroup',
            'logs:PutRetentionPolicy',
            'logs:DeleteRetentionPolicy',
            'logs:TagResource',
            'logs:UntagResource',
            'logs:ListTagsForResource',
            'logs:TagLogGroup',
            'logs:UntagLogGroup',
            'logs:ListTagsLogGroup',
          ],
          Resource: [
            `arn:aws:logs:*:*:log-group:/aws/lambda/${scope}`,
            `arn:aws:logs:*:*:log-group:/aws/lambda/${scope}:*`,
          ],
        },
        { Sid: 'LogsDescribe', Effect: 'Allow', Action: 'logs:DescribeLogGroups', Resource: '*' },
        {
          // ApiFunction's errors alarm, `<product>-<env>-<kind>-errors`. The AWS provider creates and updates it with
          // PutMetricAlarm (an update ignores tags, so tag changes go through Tag/UntagResource), reads it with
          // DescribeAlarms and ListTagsForResource, and deletes it with DeleteAlarms. Each of these but DescribeAlarms
          // takes the `alarm` resource type (arn:aws:cloudwatch:<region>:<account>:alarm:<name>) in the CloudWatch
          // service authorization reference; no condition is needed, the name scopes it.
          Sid: 'Alarms',
          Effect: 'Allow',
          Action: [
            'cloudwatch:PutMetricAlarm',
            'cloudwatch:DeleteAlarms',
            'cloudwatch:TagResource',
            'cloudwatch:UntagResource',
            'cloudwatch:ListTagsForResource',
          ],
          Resource: `arn:aws:cloudwatch:*:*:alarm:${scope}`,
        },
        { Sid: 'AlarmsDescribe', Effect: 'Allow', Action: 'cloudwatch:DescribeAlarms', Resource: '*' },
        {
          Sid: 'RolesOnlyWithBoundary',
          Effect: 'Allow',
          Action: [
            'iam:CreateRole',
            'iam:PutRolePermissionsBoundary',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:DetachRolePolicy',
          ],
          Resource: roles,
          Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
        },
        {
          Sid: 'AttachOnlyBasicExecution',
          Effect: 'Allow',
          Action: 'iam:AttachRolePolicy',
          Resource: roles,
          Condition: {
            StringEquals: { 'iam:PermissionsBoundary': boundaryArn },
            ArnEquals: { 'iam:PolicyARN': BASIC_EXECUTION },
          },
        },
        {
          Sid: 'RolesManage',
          Effect: 'Allow',
          Action: [
            'iam:GetRole',
            'iam:GetRolePolicy',
            'iam:ListRolePolicies',
            'iam:ListAttachedRolePolicies',
            'iam:ListInstanceProfilesForRole',
            'iam:DeleteRole',
            'iam:TagRole',
            'iam:UntagRole',
            'iam:UpdateRole',
            'iam:UpdateRoleDescription',
            'iam:UpdateAssumeRolePolicy',
          ],
          Resource: roles,
        },
        {
          Sid: 'PassRolesToLambda',
          Effect: 'Allow',
          Action: 'iam:PassRole',
          Resource: roles,
          // PassRole's only condition keys are iam:PassedToService and iam:AssociatedResourceArn; a boundary condition
          // here would deny every deploy. The write side carries it: this role can neither create a role in the glob
          // nor change one's policies or boundary without the boundary, and can never delete a boundary.
          Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
        },
        {
          Sid: 'NeverTouchSelfOrBoundary',
          Effect: 'Deny',
          Action: 'iam:*',
          Resource: [`arn:aws:iam::*:role/${roleName}`, `arn:aws:iam::*:policy/${boundaryName}`],
        },
        { Sid: 'NeverDropBoundary', Effect: 'Deny', Action: 'iam:DeleteRolePermissionsBoundary', Resource: '*' },
        ...stateOnly,
      ];
    };

    new aws.iam.RolePolicy(
      `${name}-policy`,
      {
        role: role.name,
        name: 'deploy',
        policy: pulumi
          .all([boundary.arn, kmsKeyArn])
          .apply(([boundaryArn, kmsKeyArn]) =>
            JSON.stringify({ Version: '2012-10-17', Statement: statements(boundaryArn, kmsKeyArn) })
          ),
      },
      child()
    );

    this.roleArn = role.arn;
    this.roleName = roleName;
    this.boundaryArn = boundary.arn as PermissionsBoundaryArn;
    this.boundaryName = boundaryName;
    this.registerOutputs({ roleArn: this.roleArn, roleName, boundaryArn: this.boundaryArn, boundaryName });
  }
}
