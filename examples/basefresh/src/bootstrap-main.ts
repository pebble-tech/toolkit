// Pulumi entry point of the bootstrap project (bootstrap/Pulumi.yaml `main: ../dist/bootstrap-main.js`).
import * as pulumi from '@pulumi/pulumi';

import { bootstrap } from './bootstrap.js';

const env = pulumi.getStack();
if (env !== 'preview' && env !== 'staging' && env !== 'prod') {
  throw new Error(`bootstrap stacks are preview, staging and prod (got "${env}")`);
}

export const outputs = bootstrap(env);
