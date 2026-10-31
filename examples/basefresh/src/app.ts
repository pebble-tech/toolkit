import { ApiFunction, Database, Stage, VercelProject, Worker } from '@pebbletech/infra';
import * as pulumi from '@pulumi/pulumi';
import * as vercel from '@pulumiverse/vercel';

/** What a basefresh stack needs from outside the program: config and secrets in a real run, fixtures in tests. */
export interface BasefreshInputs {
  apex: string;
  cloudflareZoneId: string;
  cloudflareAccountId: string;
  /** Admin URL of the Postgres cluster for this stage (secret). */
  pgAdminUrl: pulumi.Input<string>;
  /** Staging and prod: the PlanetScale-made role runtimes connect as through the pooler, and its password (secret). */
  pgRuntime?: { role: string; password: pulumi.Input<string> };
  authSecret: pulumi.Input<string>;
  /** Staging and prod: the account bootstrap's `alarmTopicArn`, which the API's errors alarm notifies. */
  alarmTopicArn?: string;
  /** Built by the product (esbuild); paths relative to the project directory. */
  bundles: { api: string; uploads: string };
}

/**
 * basefresh's whole `infra/` program. `shared` owns the Vercel project; `pr-<n>` owns a database only; `staging` and
 * `prod` own a database, the API, the uploads Worker and the web env and domain. Each cluster's `pebble_operators` group
 * belongs to the toolkit's cluster operators program, not to a product: the `Database` only grants its owner to it.
 */
export function basefresh(inputs: BasefreshInputs): Record<string, pulumi.Input<unknown>> {
  const stage = new Stage('stage', { product: 'basefresh' });

  if (stage.isShared) {
    const web = new VercelProject('web', {
      stage,
      project: {
        rootDirectory: 'apps/web',
        buildCommand: "cd ../.. && pnpm --filter '@basefresh/web' build",
        installCommand: 'cd ../.. && pnpm install --prod=false',
        devCommand: 'cd ../.. && pnpm dev:web',
      },
    });
    return {
      projectId: web.projectId,
      customEnvironmentIds: web.customEnvironmentIds,
      bypassSecret: web.bypassSecret!,
    };
  }

  if (stage.isPreview) {
    const database = new Database('db', { stage, adminUrl: inputs.pgAdminUrl });
    return { databaseName: database.databaseName, databaseUrl: database.directUrl };
  }

  // shared's state is another backend, and prod's state is in another account, so look the project up by name.
  // shared must already exist. The name is the one VercelProject creates there: `<product>-web`.
  const project = vercel.getProjectOutput({ name: `${stage.product}-web` });
  const database = new Database('db', { stage, adminUrl: inputs.pgAdminUrl, runtime: inputs.pgRuntime });
  const runtimeUrl = database.pooledUrl!;
  const webUrl = `https://${stage.hostname('app', inputs.apex)}`;

  const api = new ApiFunction('api', {
    stage,
    code: inputs.bundles.api,
    environment: { DATABASE_URL: runtimeUrl, NODE_ENV: 'production' },
    domain: { hostname: stage.hostname('api', inputs.apex), zoneId: inputs.cloudflareZoneId },
    ...(inputs.alarmTopicArn ? { alarm: { topicArn: inputs.alarmTopicArn } } : {}),
  });
  const uploads = new Worker('uploads', {
    stage,
    kind: 'uploads',
    accountId: inputs.cloudflareAccountId,
    zoneId: inputs.cloudflareZoneId,
    script: inputs.bundles.uploads,
    compatibilityDate: '2025-04-01',
    compatibilityFlags: ['nodejs_compat'],
    hostname: stage.hostname('uploads', inputs.apex),
    bucket: { binding: 'UploadsBucket' },
    vars: { UPLOAD_ALLOWED_ORIGINS: webUrl, NODE_ENV: 'production' },
    secrets: { DATABASE_URL: runtimeUrl, BETTER_AUTH_SECRET: inputs.authSecret },
  });
  const web = new VercelProject('web', {
    stage,
    projectId: project.id,
    ...(stage.isProd
      ? {}
      : {
          customEnvironmentId: vercel.getCustomEnvironmentOutput({ projectId: project.id, name: 'staging' }).id,
        }),
    vars: { APP_BASE_URL: webUrl, UPLOADS_BASE_URL: uploads.url, NODE_ENV: 'production' },
    secrets: { DATABASE_URL: runtimeUrl, BETTER_AUTH_SECRET: inputs.authSecret },
    domain: { hostname: stage.hostname('app', inputs.apex), zoneId: inputs.cloudflareZoneId },
  });

  return {
    databaseName: database.databaseName,
    // The owner's direct URL: the deploy workflows migrate with it, read before `up` (`pebble-infra outputs`).
    databaseUrl: database.directUrl,
    apiUrl: api.url,
    uploadsUrl: uploads.url,
    webUrl: web.url!,
  };
}
