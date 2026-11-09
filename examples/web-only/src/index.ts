// Pulumi entry point (Pulumi.yaml `main: dist/index.js`): reads the stack config entries.ts lists and runs the
// program. `pebble-infra` reads the `outputs` export.
import * as pulumi from '@pulumi/pulumi';

import { notes } from './app.js';

const config = new pulumi.Config();

export const outputs = notes({
  apex: config.get('apex'),
  cloudflareZoneId: config.get('cloudflareZoneId'),
  pgAdminUrl: config.getSecret('pgAdminUrl'),
});
