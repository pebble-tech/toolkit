import { Database, Stage, VercelProject } from '@pebbletech/infra';
import * as pulumi from '@pulumi/pulumi';
import * as vercel from '@pulumiverse/vercel';

/** What a stack needs from outside the program: the entries module's config in a real run, fixtures in tests. */
export interface NotesInputs {
  /** Staging and prod. */
  apex?: string;
  cloudflareZoneId?: string;
  /** `pr-<n>`, staging and prod: the product's admin URL on the cluster (secret). */
  pgAdminUrl?: pulumi.Input<string>;
  /** Staging and prod: the PlanetScale-made role runtimes connect as, and its password (secret). */
  pgRuntime?: { role: string; password: pulumi.Input<string> };
}

/**
 * A web-only product's whole `infra/` program: `shared` owns the Vercel project, `pr-<n>` a database, `staging` and
 * `prod` a database and the web app's env vars and domain. The workflow deploys the web app itself.
 */
export function notes(inputs: NotesInputs): Record<string, pulumi.Input<unknown>> {
  const stage = new Stage('stage', { product: 'notes' });

  if (stage.isShared) {
    const web = new VercelProject('web', { stage, project: { rootDirectory: 'apps/web' } });
    return { projectId: web.projectId };
  }

  if (stage.isPreview) {
    const database = new Database('db', { stage, adminUrl: inputs.pgAdminUrl! });
    return { databaseUrl: database.directUrl };
  }

  const database = new Database('db', { stage, adminUrl: inputs.pgAdminUrl!, runtime: inputs.pgRuntime });
  // shared's state is another backend, so look the project up by the name shared gave it.
  const project = vercel.getProjectOutput({ name: `${stage.product}-web` });
  const web = new VercelProject('web', {
    stage,
    projectId: project.id,
    ...(stage.isProd
      ? {}
      : { customEnvironmentId: vercel.getCustomEnvironmentOutput({ projectId: project.id, name: 'staging' }).id }),
    secrets: { DATABASE_URL: database.pooledUrl! },
    domain: { hostname: stage.hostname('app', inputs.apex!), zoneId: inputs.cloudflareZoneId! },
  });

  // The workflow reads these: the owner's URL to migrate with, and the project to deploy the web app to.
  return { databaseUrl: database.directUrl, projectId: project.id, webUrl: web.url! };
}
