// Pulumi entry point (Pulumi.yaml `main: dist/index.js`): reads the stack's config and the cluster admin's URL.
import * as pulumi from '@pulumi/pulumi';

import { adminUrlFrom, clusterOperators, settings } from './cluster-operators.js';

const config = new pulumi.Config();

export const { group, members } = clusterOperators({
  ...settings(pulumi.getStack(), {
    adoptExisting: config.getObject<unknown>('adoptExisting'),
    members: config.getObject<unknown>('members'),
    adminRole: config.get('adminRole'),
  }),
  adminUrl: adminUrlFrom(process.env),
});
