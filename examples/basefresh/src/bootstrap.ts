import { DeployRole, type DeployEnv } from '@pebbletech/infra';
import type * as pulumi from '@pulumi/pulumi';

/** basefresh's `infra/bootstrap` program: one deploy role per env (the stack name), applied by hand with SSO. */
export function bootstrap(env: DeployEnv): Record<string, pulumi.Input<unknown>> {
  const role = new DeployRole('deploy', {
    product: 'basefresh',
    env,
    apex: 'pebbletech.my',
    github: { org: 'pebble-tech', repo: 'basefresh' },
  });
  return { roleArn: role.roleArn, boundaryArn: role.boundaryArn };
}
