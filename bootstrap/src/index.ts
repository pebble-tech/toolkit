// Pulumi entry point (Pulumi.yaml `main: dist/index.js`): reads the stack's config and runs the bootstrap.
import * as pulumi from '@pulumi/pulumi';

import { bootstrap, settings } from './bootstrap.js';

const config = new pulumi.Config();

export const { oidcProviderArn, stateBucket, keyAliasArns } = bootstrap(
  settings(pulumi.getStack(), {
    accountId: config.require('accountId'),
    region: new pulumi.Config('aws').require('region'),
    oidc: config.getObject<{ import?: unknown }>('oidc'),
  })
);
