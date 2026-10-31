// Pulumi entry point (Pulumi.yaml `main: dist/index.js`): reads stack config and runs the program.
import * as pulumi from '@pulumi/pulumi';

import { basefresh } from './app.js';

const config = new pulumi.Config();
const runtimeRole = config.get('pgRuntimeRole');
const alarmTopicArn = config.get('alarmTopicArn');

export const outputs = basefresh({
  apex: config.require('apex'),
  cloudflareZoneId: config.require('cloudflareZoneId'),
  cloudflareAccountId: config.require('cloudflareAccountId'),
  pgAdminUrl: config.requireSecret('pgAdminUrl'),
  ...(runtimeRole ? { pgRuntime: { role: runtimeRole, password: config.requireSecret('pgRuntimePassword') } } : {}),
  authSecret: config.getSecret('authSecret') ?? '',
  ...(alarmTopicArn ? { alarmTopicArn } : {}),
  bundles: { api: 'bundles/api', uploads: 'bundles/uploads/server.js' },
});
