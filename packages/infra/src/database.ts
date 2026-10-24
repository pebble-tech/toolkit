import * as postgresql from '@pulumi/postgresql';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

import { DatabaseNameError, OwnershipError } from './errors.js';
import type { Stage } from './stage.js';

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const DIRECT_PORT = 5432;

export interface DatabaseRuntime {
  /** An existing role, made by PlanetScale so the pooler knows it. It is granted rights; it never owns anything. */
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
   * The role runtimes use. Required on staging and prod, where runtimes reach the database through the pooler and the
   * pooler only accepts PlanetScale-made roles. It gets CONNECT, USAGE on `public`, DML on every table and sequence, and
   * the same on tables and sequences the owner creates later. Refused on a preview, whose generated role is both owner
   * and runtime.
   */
  runtime?: DatabaseRuntime;
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

/** DML for the runtime role, on what exists now and on what the owner creates later. */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const SEQUENCE_PRIVILEGES = ['USAGE', 'SELECT', 'UPDATE'];
const SCHEMA = 'public';

/**
 * The cluster's operators group (NOLOGIN). Every database's owner role is granted to it, so a member can connect to,
 * change and drop every toolkit-managed database on the cluster. `Operators` creates it and its members, once per
 * cluster. A constant, never an argument.
 */
export const OPERATORS_GROUP = 'pebble_operators';

/**
 * postgresql 3.18.2 reads a role membership back without its grantor. On PostgreSQL 16+ the admin also holds an
 * implicit ADMIN OPTION membership in every role it creates, so a refresh can read `withAdminOption: true` and replace
 * the grant, and the replacement's delete revokes the new grant.
 */
export const KEEP_MEMBERSHIP = { ignoreChanges: ['withAdminOption'] };

/** The admin's Postgres provider: direct port 5432, `sslmode=verify-full`, never superuser, whatever the URL says. */
export function adminProvider(name: string, adminUrl: pulumi.Input<string>, parent: pulumi.Resource) {
  const admin = pulumi.secret(pulumi.output(adminUrl).apply(parseAdminUrl));
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
    { parent }
  );
  return { admin, provider };
}

/** The operators group each running program has created, keyed by its resource monitor (one per run). */
const operatorsGroups = new WeakMap<object, postgresql.Role>();

/**
 * The `pebble_operators` role for this program: created by the first `Operators` that asks, and returned to every
 * later caller, so a stack never registers it twice. `Database` only looks: it grants to the group by name.
 */
export function operatorsGroup(create?: () => postgresql.Role): postgresql.Role | undefined {
  const key = pulumi.runtime.getMonitor() as object | undefined;
  if (!key) return create?.();
  let group = operatorsGroups.get(key);
  if (!group && create) {
    group = create();
    operatorsGroups.set(key, group);
  }
  return group;
}

/**
 * A database in an existing Postgres cluster (PlanetScale), owned by a login role the component creates, with grants
 * for the runtime role on staging and prod. Outputs connection URLs as secrets. Retained and protected on prod.
 */
export class Database extends pulumi.ComponentResource {
  readonly databaseName: string;
  /** `<databaseName>_owner` on staging and prod, `<databaseName>` on a preview. Never caller-supplied. */
  readonly ownerRole: string;
  /** Direct connection (port 5432) as the owner: migrations, seeds, and previews. */
  readonly directUrl: pulumi.Output<string>;
  /** Pooled connection as the runtime role, on staging and prod only (the pooler knows no SQL-made role). */
  readonly pooledUrl: pulumi.Output<string> | undefined;

  constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
    const { stage } = args;
    // The name is the stage's, never the caller's: a preview cannot name staging's database on the shared cluster.
    stage.requireKind('a database', ['preview', 'staging', 'prod']);
    const databaseName = stage.databaseName();
    if (!IDENTIFIER.test(databaseName)) {
      throw new DatabaseNameError(`database name "${databaseName}" must match ${IDENTIFIER}`);
    }
    // The owner is always the component's own role, so the admin can create, alter and drop the database by itself.
    const ownerArgs = Object.keys(args).filter((key) => /^owner/i.test(key));
    if (ownerArgs.length > 0) {
      throw new OwnershipError(
        `Database takes no owner (${ownerArgs.join(', ')}): it creates the owner role itself. ` +
          'Since @pebbletech/infra 0.3.0 the PlanetScale-made role is passed as `runtime`'
      );
    }
    const ownerRole = stage.isPreview ? databaseName : `${databaseName}_owner`;
    if (!IDENTIFIER.test(ownerRole)) {
      throw new DatabaseNameError(`owner role "${ownerRole}" must match ${IDENTIFIER}`);
    }
    const { runtime } = args;
    if (stage.isPreview && runtime) {
      throw new OwnershipError('a preview takes no runtime role: its generated role is both owner and runtime');
    }
    if (!stage.isPreview && !runtime) {
      throw new OwnershipError(
        `${stage.env} needs an existing runtime role: runtimes use the pooler, which only knows PlanetScale-made roles`
      );
    }
    if (runtime && !IDENTIFIER.test(runtime.role)) {
      throw new DatabaseNameError(`runtime role "${runtime.role}" must match ${IDENTIFIER}`);
    }
    if (runtime && [ownerRole, OPERATORS_GROUP].includes(runtime.role)) {
      throw new OwnershipError(`the runtime role cannot be ${runtime.role}: it would hold the owner's rights`);
    }
    super('pebbletech:index:Database', name, {}, opts);

    const { admin, provider } = adminProvider(name, args.adminUrl, this);
    const withProvider = (extra?: pulumi.CustomResourceOptions) => stage.childOptions(this, { ...extra, provider });

    const password = new random.RandomPassword(
      `${name}-owner-password`,
      { length: 32, special: false },
      stage.childOptions(this)
    );
    const owner = new postgresql.Role(
      `${name}-owner`,
      { name: ownerRole, login: true, password: password.result },
      withProvider()
    );
    const ownerPassword = password.result;

    // Postgres 16+: a non-superuser can make a role the owner of a database only if it may SET ROLE to it. The admin
    // may grant this membership because it created the owner role (PlanetScale-made roles only `pscale_admin` can).
    const membership = new postgresql.GrantRole(
      `${name}-admin-member`,
      { role: admin.user.apply((user) => splitUser(user).role), grantRole: ownerRole },
      withProvider({ dependsOn: [owner], ...KEEP_MEMBERSHIP })
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

    if (runtime) {
      const grant = (kind: string, args: Omit<postgresql.GrantArgs, 'database' | 'role'>) =>
        new postgresql.Grant(
          `${name}-runtime-${kind}`,
          { database: database.name, role: runtime.role, ...args },
          withProvider()
        );
      grant('connect', { objectType: 'database', privileges: ['CONNECT'] });
      grant('schema', { objectType: 'schema', schema: SCHEMA, privileges: ['USAGE'] });
      grant('tables', { objectType: 'table', schema: SCHEMA, privileges: TABLE_PRIVILEGES });
      grant('sequences', { objectType: 'sequence', schema: SCHEMA, privileges: SEQUENCE_PRIVILEGES });
      // Tables and sequences the owner creates later (migrations run as the owner).
      for (const [kind, privileges] of [
        ['table', TABLE_PRIVILEGES],
        ['sequence', SEQUENCE_PRIVILEGES],
      ] as const) {
        new postgresql.DefaultPrivileges(
          `${name}-runtime-default-${kind}s`,
          {
            database: database.name,
            owner: ownerRole,
            role: runtime.role,
            schema: SCHEMA,
            objectType: kind,
            privileges,
          },
          withProvider()
        );
      }
    }

    // On PostgreSQL 16+ a plain GRANT gives INHERIT TRUE (the group's default) and SET TRUE. The group must exist:
    // `Operators` creates it, earlier in this stack (then this grant waits for it) or in the cluster's operators stack.
    const group = operatorsGroup();
    new postgresql.GrantRole(
      `${name}-operators`,
      { role: OPERATORS_GROUP, grantRole: ownerRole },
      withProvider({ dependsOn: [owner, ...(group ? [group] : [])], ...KEEP_MEMBERSHIP })
    );

    this.databaseName = databaseName;
    this.ownerRole = ownerRole;
    this.directUrl = pulumi.secret(
      pulumi
        .all([admin, ownerPassword, database.name])
        .apply(([a, password, db]) => connectionUrl(a, ownerRole, password, db, a.host, DIRECT_PORT))
    );
    this.pooledUrl = runtime
      ? pulumi.secret(
          pulumi
            .all([admin, runtime.password, database.name])
            .apply(([a, password, db]) =>
              connectionUrl(a, runtime.role, password, db, args.pooler?.host ?? a.host, args.pooler?.port ?? 6432)
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
