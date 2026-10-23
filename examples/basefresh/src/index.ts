// Pulumi entry point (Pulumi.yaml `main: dist/index.js`): reads stack config and runs the program.
import * as pulumi from '@pulumi/pulumi';

import { basefresh } from './app.js';

const config = new pulumi.Config();
const ownerRole = config.get('pgOwnerRole');

export const outputs = basefresh({
  apex: config.require('apex'),
  cloudflareZoneId: config.require('cloudflareZoneId'),
  cloudflareAccountId: config.require('cloudflareAccountId'),
  pgAdminUrl: config.requireSecret('pgAdminUrl'),
  ...(ownerRole ? { pgOwner: { role: ownerRole, password: config.requireSecret('pgOwnerPassword') } } : {}),
  sharedStack: config.get('sharedStack') ?? 'organization/basefresh/shared',
  authSecret: config.getSecret('authSecret') ?? '',
  bundles: { api: 'bundles/api', uploads: 'bundles/uploads/server.js' },
});
