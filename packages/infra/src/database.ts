import * as postgresql from '@pulumi/postgresql';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

import { DatabaseNameError, OwnershipError } from './errors.js';
import type { Stage } from './stage.js';

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const DIRECT_PORT = 5432;

export interface DatabaseRuntime {
  /** An existing role, used instead of the one the component makes. It is granted rights; it never owns anything. */
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
   * An existing role for runtimes on staging and prod. Without it the component makes `<database>_runtime`, a login
   * role with a generated password; the pooler accepts a role made with SQL. Either role gets CONNECT, USAGE on
   * `public`, DML on every table and sequence, and the same on tables and sequences the owner creates later. Refused on
   * a preview, whose generated role is both owner and runtime.
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

/** Each running program's one `Operators` and the group it registered, keyed by its resource monitor (one per run). */
const operatorsInProgram = new WeakMap<object, { name: string; group?: postgresql.Role }>();
const programKey = () => pulumi.runtime.getMonitor() as object | undefined;

/**
 * Records `name` as this program's `Operators`. Refuses a second one: two would each manage the same memberships, and
 * dropping a name from one list would revoke a membership the other still declares.
 */
export function claimOperators(name: string): (group: postgresql.Role) => void {
  const key = programKey();
  const first = key && operatorsInProgram.get(key);
  if (first) {
    throw new OwnershipError(
      `one Operators per program: "${first.name}" already manages ${OPERATORS_GROUP}, so "${name}" cannot`
    );
  }
  const entry: { name: string; group?: postgresql.Role } = { name };
  if (key) operatorsInProgram.set(key, entry);
  return (group) => {
    entry.group = group;
  };
}

/** The `pebble_operators` role this program's `Operators` registered, if any. `Database` grants to it by name. */
export function operatorsGroup(): postgresql.Role | undefined {
  const key = programKey();
  return key ? operatorsInProgram.get(key)?.group : undefined;
}

/** Every string property name `args` carries: own (enumerable or not) and inherited, short of `Object.prototype`. */
function propertyNames(args: object): string[] {
  const names = new Set<string>();
  for (let level: object | null = args; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const key of Reflect.ownKeys(level)) if (typeof key === 'string') names.add(key);
  }
  return [...names];
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
  /** `<databaseName>_runtime` on staging and prod unless `runtime` names another role; none on a preview. */
  readonly runtimeRole: string | undefined;
  /** Pooled connection (port 6432) as the runtime role, on staging and prod only. */
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
    const ownerArgs = propertyNames(args).filter((key) => /^owner/i.test(key));
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
    if (stage.isPreview && args.runtime) {
      throw new OwnershipError('a preview takes no runtime role: its generated role is both owner and runtime');
    }
    const runtimeRole = stage.isPreview ? undefined : (args.runtime?.role ?? `${databaseName}_runtime`);
    if (runtimeRole && !IDENTIFIER.test(runtimeRole)) {
      throw new DatabaseNameError(`runtime role "${runtimeRole}" must match ${IDENTIFIER}`);
    }
    if (runtimeRole && [ownerRole, OPERATORS_GROUP].includes(runtimeRole)) {
      throw new OwnershipError(`the runtime role cannot be ${runtimeRole}: it would hold the owner's rights`);
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

    let runtime: { role: pulumi.Input<string>; password: pulumi.Input<string> } | undefined = args.runtime;
    if (runtimeRole && !runtime) {
      const runtimePassword = new random.RandomPassword(
        `${name}-runtime-password`,
        { length: 32, special: false },
        stage.childOptions(this)
      );
      const role = new postgresql.Role(
        `${name}-runtime`,
        { name: runtimeRole, login: true, password: runtimePassword.result },
        withProvider()
      );
      // The grants take the role's name output, so they wait for the role and go before it on delete.
      runtime = { role: role.name, password: runtimePassword.result };
    }

    // The runtime role's grants. The pooled URL waits for them, so no consumer gets it before the role can log in.
    const runtimeGrants: pulumi.CustomResource[] = [];
    if (runtime) {
      const role = runtime.role;
      const grant = (kind: string, args: Omit<postgresql.GrantArgs, 'database' | 'role'>) =>
        runtimeGrants.push(
          new postgresql.Grant(`${name}-runtime-${kind}`, { database: database.name, role, ...args }, withProvider())
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
        const defaults = new postgresql.DefaultPrivileges(
          `${name}-runtime-default-${kind}s`,
          {
            database: database.name,
            owner: ownerRole,
            role,
            schema: SCHEMA,
            objectType: kind,
            privileges,
          },
          withProvider()
        );
        runtimeGrants.push(defaults);
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
    this.runtimeRole = runtimeRole;
    this.directUrl = pulumi.secret(
      pulumi
        .all([admin, ownerPassword, database.name])
        .apply(([a, password, db]) => connectionUrl(a, ownerRole, password, db, a.host, DIRECT_PORT))
    );
    this.pooledUrl =
      runtime && runtimeRole
        ? pulumi.secret(
            pulumi
              .all([admin, runtime.password, database.name, pulumi.all(runtimeGrants.map((grant) => grant.id))])
              .apply(([a, password, db]) =>
                connectionUrl(a, runtimeRole, password, db, args.pooler?.host ?? a.host, args.pooler?.port ?? 6432)
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
