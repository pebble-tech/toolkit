import { ApiFunction, Database, Operators, Stage, VercelProject, Worker } from '@pebbletech/infra';
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
  /** `shared`, `prod`: the PlanetScale role names in that cluster's `pebble_operators` group (config, may be empty). */
  operators?: string[];
  authSecret: pulumi.Input<string>;
  /** Built by the product (esbuild); paths relative to the project directory. */
  bundles: { api: string; uploads: string };
}

/**
 * basefresh's whole `infra/` program. `shared` owns the Vercel project and the staging cluster's operators group;
 * `pr-<n>` owns a database only; `staging` and `prod` own a database, the API, the uploads Worker and the web env and
 * domain, and `prod` also owns the production cluster's operators group.
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
    // One Operators per cluster: `shared` for the staging cluster, `prod` for the production cluster. basefresh owns the
    // group only because it is alone on its cluster; on a cluster another product owns, it constructs no Operators.
    new Operators('operators', { stage, adminUrl: inputs.pgAdminUrl, members: inputs.operators ?? [] });
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
  // The production cluster's operators group, before the Database that grants its owner to it.
  if (stage.isProd) new Operators('operators', { stage, adminUrl: inputs.pgAdminUrl, members: inputs.operators ?? [] });
  const database = new Database('db', { stage, adminUrl: inputs.pgAdminUrl, runtime: inputs.pgRuntime });
  const runtimeUrl = database.pooledUrl!;
  const webUrl = `https://${stage.hostname('app', inputs.apex)}`;

  const api = new ApiFunction('api', {
    stage,
    code: inputs.bundles.api,
    environment: { DATABASE_URL: runtimeUrl, NODE_ENV: 'production' },
    domain: { hostname: stage.hostname('api', inputs.apex), zoneId: inputs.cloudflareZoneId },
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
    apiUrl: api.url,
    uploadsUrl: uploads.url,
    webUrl: web.url!,
  };
}
