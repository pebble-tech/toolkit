import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { assertProduct, boundaryPolicyName, type DeployEnv, type PermissionsBoundaryArn } from './stage.js';

const BASIC_EXECUTION = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const GITHUB_ENVIRONMENT: Record<DeployEnv, string> = { preview: 'preview', staging: 'staging', prod: 'production' };

export interface DeployRoleArgs {
  product: string;
  /** The stacks this role deploys: `preview` covers every `pr-<n>` stack. */
  env: DeployEnv;
  github: {
    org: string;
    repo: string;
    /** GitHub environments allowed to assume the role; default `preview`, `staging` or `production` by env. */
    environments?: string[];
  };
  /** The account's GitHub OIDC provider (shared bootstrap). */
  oidcProviderArn: pulumi.Input<string>;
  state: {
    /** Pulumi state bucket name. */
    bucket: string;
    /** Key prefixes this role may read and write; default `<product>/<env>`. Staging adds `<product>/shared`. */
    paths?: string[];
    /** KMS key that encrypts this role's stack secrets. */
    kmsKeyArn: pulumi.Input<string>;
  };
}

type Statement = Record<string, unknown>;

/**
 * The role a product's GitHub workflow assumes for one env, plus the permissions boundary every role it creates must
 * carry. Applied by hand once per product and env from the product's `infra/bootstrap` stack.
 */
export class DeployRole extends pulumi.ComponentResource {
  readonly roleArn: pulumi.Output<string>;
  readonly roleName: string;
  readonly boundaryArn: PermissionsBoundaryArn;
  readonly boundaryName: string;

  constructor(name: string, args: DeployRoleArgs, opts?: pulumi.ComponentResourceOptions) {
    assertProduct(args.product);
    super('pebbletech:index:DeployRole', name, {}, opts);

    const { product, env } = args;
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

    const subs = (args.github.environments ?? [GITHUB_ENVIRONMENT[env]]).map(
      (environment) => `repo:${args.github.org}/${args.github.repo}:environment:${environment}`
    );
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
              Principal: { Federated: args.oidcProviderArn },
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

    const paths = args.state.paths ?? [`${product}/${env}`];
    const roles = `arn:aws:iam::*:role/${scope}`;
    // Stage tags carry the stack's env (`pr-7` on a preview).
    const tagged = (prefix: 'aws:RequestTag' | 'aws:ResourceTag') => ({
      StringLike: { [`${prefix}/product`]: product, [`${prefix}/env`]: env === 'preview' ? 'pr-*' : env },
    });
    const statements = (boundaryArn: string, kmsKeyArn: string): Statement[] => [
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
      {
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
        Resource: [
          'arn:aws:apigateway:*::/apis',
          'arn:aws:apigateway:*::/apis/*',
          'arn:aws:apigateway:*::/domainnames',
          'arn:aws:apigateway:*::/domainnames/*',
          'arn:aws:apigateway:*::/tags/*',
        ],
      },
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
        // Only roles that carry the boundary: a leftover role in the name glob without it cannot be passed.
        Condition: {
          StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com', 'iam:PermissionsBoundary': boundaryArn },
        },
      },
      {
        Sid: 'NeverTouchSelfOrBoundary',
        Effect: 'Deny',
        Action: 'iam:*',
        Resource: [`arn:aws:iam::*:role/${roleName}`, `arn:aws:iam::*:policy/${boundaryName}`],
      },
      { Sid: 'NeverDropBoundary', Effect: 'Deny', Action: 'iam:DeleteRolePermissionsBoundary', Resource: '*' },
      {
        Sid: 'StateList',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${args.state.bucket}`,
        Condition: { StringLike: { 's3:prefix': paths.flatMap((path) => [path, `${path}/*`]) } },
      },
      {
        Sid: 'StateObjects',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: paths.map((path) => `arn:aws:s3:::${args.state.bucket}/${path}/*`),
      },
      {
        Sid: 'StateSecrets',
        Effect: 'Allow',
        Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        Resource: kmsKeyArn,
      },
    ];

    new aws.iam.RolePolicy(
      `${name}-policy`,
      {
        role: role.name,
        name: 'deploy',
        policy: pulumi
          .all([boundary.arn, args.state.kmsKeyArn])
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
