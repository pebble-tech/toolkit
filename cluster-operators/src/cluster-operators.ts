import { OPERATORS_GROUP, Operators, OwnershipError } from '@pebbletech/infra';
import * as pulumi from '@pulumi/pulumi';
import pg from 'pg';

/** One stack per Postgres cluster, named after it. */
export const CLUSTERS = ['pebble-stg', 'pebble-prd-shared'] as const;
export type Cluster = (typeof CLUSTERS)[number];

/** The environment variable that holds the cluster admin's URL: never stack config, so never in a committed file. */
export const ADMIN_URL_ENV = 'CLUSTER_ADMIN_URL';

export interface ClusterSettings {
  cluster: Cluster;
  /** Adopt the cluster's existing `pebble_operators` (the handover) instead of creating it. */
  adoptExisting: boolean;
  /** SQL role names in the group, from the stack's secret `members` config. */
  members: string[];
  /** This cluster's cluster admin role, from stack config: a URL for another cluster's admin is refused. */
  adminRole: string;
}

/** Checks the stack name and the config the entry point read; throws on anything the program cannot run with. */
export function settings(
  stack: string,
  config: { adoptExisting?: unknown; members?: unknown; adminRole?: unknown }
): ClusterSettings {
  const cluster = CLUSTERS.find((name) => name === stack);
  if (!cluster) {
    throw new Error(`pebble-cluster-operators stacks are ${CLUSTERS.join(' and ')}, one per cluster (got "${stack}")`);
  }
  const adoptExisting = config.adoptExisting ?? false;
  if (typeof adoptExisting !== 'boolean') throw new Error('adoptExisting must be true or false');
  // Required, even when empty: a missing list would revoke every membership this stack granted.
  const { members } = config;
  if (!Array.isArray(members) || members.some((member) => typeof member !== 'string')) {
    throw new Error(
      'members must be a list of role names, set as a secret (pulumi config set --secret members \'["<role>"]\')'
    );
  }
  const { adminRole } = config;
  if (typeof adminRole !== 'string' || adminRole === '' || adminRole.includes('.')) {
    throw new Error("adminRole must be this cluster's cluster admin role, without a .<branch> suffix");
  }
  return { cluster, adoptExisting, members, adminRole };
}

/**
 * Refuses an admin URL whose user is not this stack's cluster admin, before any connection: each cluster has its own
 * roles, so another cluster's URL names another role. The role is the username before a PlanetScale `.<branch>`.
 */
export function assertClusterAdmin(adminUrl: string, adminRole: string): void {
  const role = decodeURIComponent(new URL(adminUrl).username).split('.')[0];
  if (role !== adminRole) {
    throw new Error(`${ADMIN_URL_ENV} is for role "${role}", not this stack's cluster admin "${adminRole}"`);
  }
}

/** The cluster admin's URL from the environment; refuses an unset or empty value. */
export function adminUrlFrom(env: NodeJS.ProcessEnv): string {
  const url = env[ADMIN_URL_ENV];
  if (!url) throw new Error(`${ADMIN_URL_ENV} is unset: export the cluster admin's URL (README, Before you start)`);
  return url;
}

interface Membership {
  member: string;
  grantor: string;
}

/**
 * Reads `pebble_operators`' memberships that give access (INHERIT or SET) and that the connecting admin did not grant.
 * On PostgreSQL 16+ only the granting role revokes a membership, so this program cannot take any of them away.
 * Returns a warning for each one whose member is on the list; throws OwnershipError naming every one whose member is
 * not, because removing that name here would leave the person in the group.
 */
export async function checkMemberships(adminUrl: string, members: string[]): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  let rows: Membership[];
  let self: string;
  try {
    self = (await client.query<{ self: string }>('select current_user as self')).rows[0]!.self;
    rows = (
      await client.query<Membership>(
        `select pg_get_userbyid(m.member) as member, pg_get_userbyid(m.grantor) as grantor
         from pg_auth_members m
         where m.roleid = (select oid from pg_roles where rolname = $1)
           and (m.inherit_option or m.set_option)
           and m.grantor <> (select oid from pg_roles where rolname = current_user)
         order by 1, 2`,
        [OPERATORS_GROUP]
      )
    ).rows;
  } finally {
    await client.end();
  }

  const listed = rows.filter((row) => members.includes(row.member));
  const unlisted = rows.filter((row) => !members.includes(row.member));
  if (unlisted.length > 0) {
    const lines = unlisted.map(({ member, grantor }) =>
      member === self
        ? `- ${member}, this cluster admin, holds access granted by ${grantor}; as ${grantor}: ` +
          `GRANT ${OPERATORS_GROUP} TO "${member}" WITH INHERIT FALSE, SET FALSE;`
        : `- ${member}, granted by ${grantor}; as ${grantor}: REVOKE ${OPERATORS_GROUP} FROM "${member}";`
    );
    throw new OwnershipError(
      `${OPERATORS_GROUP} has memberships this program cannot revoke, for roles not in members:\n${lines.join('\n')}\n` +
        'On PostgreSQL 16+ only the role that granted a membership can revoke it. If a product stack still ' +
        'constructs Operators, finish the handover (cluster-operators README) instead; otherwise run each line, or ' +
        'add the role to members.'
    );
  }
  return listed.map(
    ({ member, grantor }) =>
      `${member}'s membership in ${OPERATORS_GROUP} is also granted by ${grantor} (a product stack's Operators or a ` +
      `hand grant): removing ${member} from members will not take it away until ${grantor} revokes it`
  );
}

export interface ClusterOperatorsArgs extends ClusterSettings {
  adminUrl: string;
}

/**
 * The cluster's `pebble_operators` group and its members, administered by the cluster admin. Nothing is registered
 * until `checkMemberships` has passed: the admin URL every resource uses resolves only after it.
 */
export function clusterOperators(args: ClusterOperatorsArgs) {
  const { cluster, adoptExisting, members } = args;
  assertClusterAdmin(args.adminUrl, args.adminRole);
  const adminUrl = pulumi.secret(
    pulumi.output(args.adminUrl).apply(async (url) => {
      for (const warning of await checkMemberships(url, members)) pulumi.log.warn(warning);
      return url;
    })
  );
  const operators = new Operators('operators', { cluster, adoptExisting, adminUrl, members });
  return { group: operators.group, members: pulumi.secret(members) };
}
