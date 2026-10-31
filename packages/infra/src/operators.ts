import * as postgresql from '@pulumi/postgresql';
import * as pulumi from '@pulumi/pulumi';

import { KEEP_MEMBERSHIP, OPERATORS_GROUP, adminProvider, claimOperators } from './database.js';
import { OwnershipError } from './errors.js';
import type { Stage } from './stage.js';

/** A cluster stack's name: `pebble-` and lowercase kebab words, as the shared prefix reserves (`pebble-stg`). */
const CLUSTER = /^pebble(?:-[a-z0-9]+)+$/;

export interface OperatorsArgs {
  /**
   * 0.3.x: the product stack that owns the group on its cluster, `shared` or `prod`. Give `stage` or `cluster`, not
   * both. A product program no longer needs it once the cluster's operators program owns the group (README, Operators).
   */
  stage?: Stage;
  /**
   * The cluster's own operators program: the cluster's name (`pebble-stg`), its stack name. The group is protected and
   * kept on delete, as on prod. Its admin is the cluster admin, a role no product uses.
   */
  cluster?: string;
  /**
   * With `cluster` only: adopt the cluster's existing `pebble_operators` (Pulumi `import`) instead of creating it, for
   * the handover from a product's stacks. Turn it off once the stack holds the group.
   */
  adoptExisting?: boolean;
  /** Admin connection URL for the cluster, as for `Database`. */
  adminUrl: pulumi.Input<string>;
  /**
   * SQL role names of the people in `pebble_operators`: a PlanetScale role's username without its `.<branch>` suffix
   * (`pscale_api_xxx`, not `pscale_api_xxx.main`). A name with a dot is refused.
   * Read them from stack config so they are not committed. Plain strings: each grant is named after its member, so
   * removing a name revokes exactly that membership on the next apply.
   */
  members: string[];
}

/** Where the group lives: a product stack (0.3.x) or the cluster's own program. Throws on anything else. */
function owner(args: OperatorsArgs): { stage: Stage; cluster?: undefined } | { stage?: undefined; cluster: string } {
  const { stage, cluster } = args;
  if (stage && cluster !== undefined) {
    throw new OwnershipError('Operators takes a stage or a cluster, not both');
  }
  if (cluster !== undefined) {
    if (!CLUSTER.test(cluster)) {
      throw new OwnershipError(`cluster "${cluster}" must be pebble- and lowercase kebab words, such as pebble-stg`);
    }
    return { cluster };
  }
  if (!stage)
    throw new OwnershipError('Operators needs a stage (a product program) or a cluster (the cluster program)');
  // The group is cluster-wide: one stack per cluster owns it, never a preview or a second stack on the same cluster.
  stage.requireKind('the operators group', ['shared', 'prod']);
  if (args.adoptExisting) {
    throw new OwnershipError("adoptExisting is for the cluster's operators program (cluster), not a product stack");
  }
  return { stage };
}

/**
 * The cluster's `pebble_operators` group and its members, as code. One `Operators` per cluster and one per program:
 * in the cluster's operators program (`cluster`), or, from 0.3.x until the handover, in a product's `shared` stack for
 * the staging cluster and its `prod` stack for the production cluster (`stage`). Every `Database` grants its owner role
 * to the group.
 */
export class Operators extends pulumi.ComponentResource {
  readonly group = OPERATORS_GROUP;

  constructor(name: string, args: OperatorsArgs, opts?: pulumi.ComponentResourceOptions) {
    const { members } = args;
    const { stage, cluster } = owner(args);
    for (const member of members) {
      if (member.trim() === '') throw new OwnershipError('an operator member name cannot be empty');
      // A PlanetScale login username is `<role>.<branch>`; the role is the part before the dot. Granting the full
      // username fails only at apply, with `role "<role>.<branch>" does not exist`.
      const dot = member.indexOf('.');
      if (dot !== -1) {
        throw new OwnershipError(
          `operator member "${member}" is a login username, not a role: ` +
            `drop the "${member.slice(dot)}" suffix and list "${member.slice(0, dot)}"`
        );
      }
    }
    const duplicate = members.find((member, index) => members.indexOf(member) !== index);
    if (duplicate) throw new OwnershipError(`operator member ${duplicate} is listed twice`);
    const registerGroup = claimOperators(name);
    super('pebbletech:index:Operators', name, {}, opts);

    const { provider } = adminProvider(name, args.adminUrl, this);
    // Kept when this stack goes: other stacks' databases are granted to it, and dropping it drops their memberships.
    // `roles` (what the group is a member of) is every database's owner, granted by each `Database`: a refresh reads
    // them back, and without ignoreChanges the next apply would revoke them all.
    const groupOptions = { provider, retainOnDelete: true, ignoreChanges: ['roles'] };
    const group = new postgresql.Role(
      `${name}-group`,
      { name: OPERATORS_GROUP, login: false },
      stage
        ? stage.childOptions(this, groupOptions)
        : {
            ...groupOptions,
            parent: this,
            protect: true,
            ...(args.adoptExisting ? { import: OPERATORS_GROUP } : {}),
          }
    );
    registerGroup(group);
    // Not protected, unlike the stage's other children: removing a member from the list must revoke the grant. On
    // PostgreSQL 16+ a REVOKE removes only the membership row this admin granted, so each grant is this admin's own.
    for (const member of members) {
      new postgresql.GrantRole(
        `${name}-member-${member}`,
        { role: member, grantRole: OPERATORS_GROUP },
        { parent: this, provider, dependsOn: [group], ...KEEP_MEMBERSHIP }
      );
    }
    this.registerOutputs({ group: OPERATORS_GROUP, members, ...(cluster ? { cluster } : {}) });
  }
}
