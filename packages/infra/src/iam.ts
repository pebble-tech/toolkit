import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { PermissionsBoundaryError } from './errors.js';
import { boundaryPolicyName, type PermissionsBoundaryArn, type Stage } from './stage.js';

const POLICY_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):policy\/([^/]+)$/;

/**
 * The boundary as it reaches IAM: the policy `<product>-<deploy env>-boundary` in the account the AWS provider points
 * at, and nothing else. Checked inside `apply`, so an Output of anything else fails `pulumi preview`.
 */
function checkedBoundary(
  stage: Stage,
  boundary: PermissionsBoundaryArn,
  parent: pulumi.Resource | undefined
): pulumi.Output<string> {
  const expected = boundaryPolicyName(stage.product, stage.deployEnv);
  const { accountId } = aws.getCallerIdentityOutput({}, { parent });
  return pulumi.all([boundary as pulumi.Output<unknown>, accountId]).apply(([arn, account]) => {
    const match = typeof arn === 'string' ? POLICY_ARN.exec(arn) : null;
    if (!match || match[1] !== account || match[2] !== expected) {
      throw new PermissionsBoundaryError(
        `permissions boundary must be arn:aws:iam::${account}:policy/${expected} (got ${JSON.stringify(arn)})`
      );
    }
    return arn as string;
  });
}

export interface BoundedRoleArgs {
  stage: Stage;
  roleName: string;
  /** The AWS service that assumes the role, e.g. `lambda.amazonaws.com`. */
  service: string;
  /** Defaults to `stage.permissionsBoundaryArn()`; anything else must resolve to that same ARN. */
  permissionsBoundary?: PermissionsBoundaryArn;
}

/** The only way this package creates a workload role: the stage's boundary, a name inside the stage namespace. */
export function boundedRole(name: string, args: BoundedRoleArgs, opts: pulumi.CustomResourceOptions): aws.iam.Role {
  const boundary = checkedBoundary(
    args.stage,
    args.permissionsBoundary === undefined ? args.stage.permissionsBoundaryArn() : args.permissionsBoundary,
    opts.parent
  );
  return new aws.iam.Role(
    name,
    {
      name: args.roleName,
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: args.service }, Action: 'sts:AssumeRole' }],
      }),
      permissionsBoundary: boundary,
      tags: args.stage.tags,
    },
    opts
  );
}
