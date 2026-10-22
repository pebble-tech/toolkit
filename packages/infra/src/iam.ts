import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { PermissionsBoundaryError } from './errors.js';
import type { Stage } from './stage.js';

const POLICY_ARN = /^arn:aws[a-z-]*:iam::\d{12}:policy\/.+/;

/** Which deploy role serves a stage: one `preview` role covers every `pr-<n>` stack. */
export type DeployEnv = 'preview' | 'staging' | 'prod';

/** Name of the permissions boundary policy a stage's roles carry; `DeployRole` creates it. */
export function boundaryPolicyName(product: string, env: DeployEnv): string {
  return `${product}-${env}-boundary`;
}

/** The stage's boundary ARN in the account the AWS provider points at. */
export function defaultBoundaryArn(stage: Stage, parent: pulumi.Resource): pulumi.Output<string> {
  const env: DeployEnv = stage.isPreview ? 'preview' : stage.isProd ? 'prod' : 'staging';
  const { accountId } = aws.getCallerIdentityOutput({}, { parent });
  return pulumi.interpolate`arn:aws:iam::${accountId}:policy/${boundaryPolicyName(stage.product, env)}`;
}

/** Throws PermissionsBoundaryError unless the boundary is given and, when known now, an IAM policy ARN. */
export function assertBoundary(boundary: pulumi.Input<string> | undefined): asserts boundary is pulumi.Input<string> {
  if (boundary === undefined || boundary === null || boundary === '') {
    throw new PermissionsBoundaryError('an IAM role needs a permissions boundary');
  }
  if (typeof boundary === 'string' && !POLICY_ARN.test(boundary)) {
    throw new PermissionsBoundaryError(`permissions boundary "${boundary}" is not an IAM policy ARN`);
  }
}

export interface BoundedRoleArgs {
  stage: Stage;
  roleName: string;
  /** The AWS service that assumes the role, e.g. `lambda.amazonaws.com`. */
  service: string;
  permissionsBoundary: pulumi.Input<string>;
}

/** The only way this package creates a workload role: boundary required, name inside the stage namespace. */
export function boundedRole(name: string, args: BoundedRoleArgs, opts: pulumi.CustomResourceOptions): aws.iam.Role {
  assertBoundary(args.permissionsBoundary);
  return new aws.iam.Role(
    name,
    {
      name: args.roleName,
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: args.service }, Action: 'sts:AssumeRole' }],
      }),
      permissionsBoundary: args.permissionsBoundary,
      tags: args.stage.tags,
    },
    opts
  );
}
