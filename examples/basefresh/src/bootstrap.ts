import { DeployRole } from '@pebbletech/infra';
import type * as pulumi from '@pulumi/pulumi';

export interface BootstrapInputs {
  /** Stack name of the bootstrap project: `preview`, `staging` or `prod`. */
  env: 'preview' | 'staging' | 'prod';
  oidcProviderArn: pulumi.Input<string>;
  stateBucket: string;
  kmsKeyArn: pulumi.Input<string>;
}

/** basefresh's `infra/bootstrap` program: one deploy role per env, applied by hand with SSO. */
export function bootstrap(inputs: BootstrapInputs): Record<string, pulumi.Input<unknown>> {
  const role = new DeployRole('deploy', {
    product: 'basefresh',
    env: inputs.env,
    github: { org: 'pebble-tech', repo: 'basefresh' },
    oidcProviderArn: inputs.oidcProviderArn,
    state: {
      bucket: inputs.stateBucket,
      // staging also runs `pulumi up -s shared`
      paths: inputs.env === 'staging' ? ['basefresh/staging', 'basefresh/shared'] : [`basefresh/${inputs.env}`],
      kmsKeyArn: inputs.kmsKeyArn,
    },
  });
  return { roleArn: role.roleArn, boundaryArn: role.boundaryArn };
}
