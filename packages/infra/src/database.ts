import * as postgresql from '@pulumi/postgresql';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

import { DatabaseNameError, OwnershipError } from './errors.js';
import type { Stage } from './stage.js';

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const DIRECT_PORT = 5432;

export interface DatabaseOwner {
  /** An existing role, made by PlanetScale so the pooler knows it. */
  role: string;
  /** That role's password, as a secret. */
  password: pulumi.Input<string>;
}

export interface DatabaseArgs {
  stage: Stage;
  /**
   * Admin connection URL for the cluster (a role with CREATEDB and CREATEROLE, not a superuser), as a secret. The
   * component always connects on the direct port 5432 with `sslmode=verify-full`, whatever the URL says.
   */
  adminUrl: pulumi.Input<string>;
  /**
   * The role that owns the database. Required on staging and prod, where runtimes reach the database through the
   * pooler and the pooler only accepts PlanetScale-made roles. On a preview, leave it out: the component creates a
   * login role named after the database with a generated password.
   */
  owner?: DatabaseOwner;
  /** The pooler endpoint; defaults to the admin host on port 6432. */
  pooler?: { host?: string; port?: number };
}

interface ParsedUrl {
  host: string;
  user: string;
  password: string;
  database: string;
  search: string;
}

function parseAdminUrl(raw: string): ParsedUrl {
  const url = new URL(raw);
  return {
    host: url.hostname,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || 'postgres',
    search: url.search,
  };
}

/** PlanetScale routes by a `.branch` suffix on the username; SQL role names carry none. */
function splitUser(user: string): { role: string; branch: string } {
  const dot = user.lastIndexOf('.');
  return dot === -1 ? { role: user, branch: '' } : { role: user.slice(0, dot), branch: user.slice(dot + 1) };
}

function connectionUrl(admin: ParsedUrl, role: string, password: string, database: string, host: string, port: number) {
  const { branch } = splitUser(admin.user);
  const url = new URL(`postgresql://${host}:${port}/${database}${admin.search}`);
  url.username = branch ? `${role}.${branch}` : role;
  url.password = password;
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

/**
 * A database in an existing Postgres cluster (PlanetScale), with its owner and grants. Outputs connection URLs as
 * secrets. Retained and protected on prod.
 */
export class Database extends pulumi.ComponentResource {
  readonly databaseName: string;
  readonly ownerRole: string;
  /** Direct connection (port 5432): migrations, seeds, and previews. */
  readonly directUrl: pulumi.Output<string>;
  /** Pooled connection, only when the owner is a PlanetScale-made role (the pooler knows no other). */
  readonly pooledUrl: pulumi.Output<string> | undefined;

  constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
    const { stage } = args;
    // The name is the stage's, never the caller's: a preview cannot name staging's database on the shared cluster.
    stage.requireKind('a database', ['preview', 'staging', 'prod']);
    const databaseName = stage.databaseName();
    if (!IDENTIFIER.test(databaseName)) {
      throw new DatabaseNameError(`database name "${databaseName}" must match ${IDENTIFIER}`);
    }
    if (!stage.isPreview && !args.owner) {
      throw new OwnershipError(
        `${stage.env} needs an existing owner role: runtimes use the pooler, which only knows PlanetScale-made roles`
      );
    }
    if (args.owner && !IDENTIFIER.test(args.owner.role)) {
      throw new DatabaseNameError(`owner role "${args.owner.role}" must match ${IDENTIFIER}`);
    }
    super('pebbletech:index:Database', name, {}, opts);

    const admin = pulumi.secret(pulumi.output(args.adminUrl).apply(parseAdminUrl));
    const provider = new postgresql.Provider(
      `${name}-admin`,
      {
        host: admin.host,
        port: DIRECT_PORT,
        username: admin.user,
        databaseUsername: admin.user.apply((user) => splitUser(user).role),
        password: admin.password,
        database: admin.database,
        sslmode: 'verify-full',
        superuser: false,
      },
      // Not protected: a provider is configuration, not a cloud resource, and a protected one blocks a config change.
      { parent: this }
    );
    const withProvider = (extra?: pulumi.CustomResourceOptions) => stage.childOptions(this, { ...extra, provider });

    let ownerRole: string;
    let ownerPassword: pulumi.Output<string>;
    let ownerReady: pulumi.Resource[];
    if (args.owner) {
      ownerRole = args.owner.role;
      ownerPassword = pulumi.secret(args.owner.password);
      ownerReady = [];
    } else {
      ownerRole = databaseName;
      const password = new random.RandomPassword(
        `${name}-owner-password`,
        { length: 32, special: false },
        stage.childOptions(this)
      );
      const role = new postgresql.Role(
        `${name}-owner`,
        { name: ownerRole, login: true, password: password.result },
        withProvider()
      );
      ownerPassword = password.result;
      ownerReady = [role];
    }

    // Postgres 16+: a non-superuser can make a role the owner of a database only if it may SET ROLE to it.
    const membership = new postgresql.GrantRole(
      `${name}-admin-member`,
      { role: admin.user.apply((user) => splitUser(user).role), grantRole: ownerRole },
      withProvider({ dependsOn: ownerReady })
    );
    const database = new postgresql.Database(
      name,
      { name: databaseName, owner: ownerRole },
      withProvider({ dependsOn: [membership] })
    );
    new postgresql.Grant(
      `${name}-revoke-public`,
      { database: database.name, role: 'public', objectType: 'database', privileges: [] },
      withProvider()
    );

    this.databaseName = databaseName;
    this.ownerRole = ownerRole;
    this.directUrl = pulumi.secret(
      pulumi
        .all([admin, ownerPassword, database.name])
        .apply(([a, password, db]) => connectionUrl(a, ownerRole, password, db, a.host, DIRECT_PORT))
    );
    this.pooledUrl = args.owner
      ? pulumi.secret(
          pulumi
            .all([admin, ownerPassword, database.name])
            .apply(([a, password, db]) =>
              connectionUrl(a, ownerRole, password, db, args.pooler?.host ?? a.host, args.pooler?.port ?? 6432)
            )
        )
      : undefined;

    this.registerOutputs({
      databaseName,
      ownerRole,
      directUrl: this.directUrl,
      ...(this.pooledUrl ? { pooledUrl: this.pooledUrl } : {}),
    });
  }
}
