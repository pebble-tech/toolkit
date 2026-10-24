import * as postgresql from '@pulumi/postgresql';
import * as pulumi from '@pulumi/pulumi';

import { KEEP_MEMBERSHIP, OPERATORS_GROUP, adminProvider, operatorsGroup } from './database.js';
import { OwnershipError } from './errors.js';
import type { Stage } from './stage.js';

export interface OperatorsArgs {
  stage: Stage;
  /** Admin connection URL for the cluster, as for `Database`. */
  adminUrl: pulumi.Input<string>;
  /**
   * SQL role names (PlanetScale role usernames, without the `.<branch>` suffix) of the people in `pebble_operators`.
   * Read them from stack config so they are not committed. Plain strings: each grant is named after its member, so
   * removing a name revokes exactly that membership on the next apply.
   */
  members: string[];
}

/**
 * The cluster's `pebble_operators` group and its members, as code. One stack per cluster applies it: `shared` on the
 * staging cluster, `prod` on the production cluster. Every `Database` grants its owner role to the group.
 */
export class Operators extends pulumi.ComponentResource {
  readonly group = OPERATORS_GROUP;

  constructor(name: string, args: OperatorsArgs, opts?: pulumi.ComponentResourceOptions) {
    const { stage, members } = args;
    // The group is cluster-wide: one stack per cluster owns it, never a preview or a second stack on the same cluster.
    stage.requireKind('the operators group', ['shared', 'prod']);
    for (const member of members) {
      if (member.trim() === '') throw new OwnershipError('an operator member name cannot be empty');
    }
    const duplicate = members.find((member, index) => members.indexOf(member) !== index);
    if (duplicate) throw new OwnershipError(`operator member ${duplicate} is listed twice`);
    super('pebbletech:index:Operators', name, {}, opts);

    const { provider } = adminProvider(name, args.adminUrl, this);
    // Kept when this stack goes: other stacks' databases are granted to it, and dropping it drops their memberships.
    const group = operatorsGroup(
      () =>
        new postgresql.Role(
          `${name}-group`,
          { name: OPERATORS_GROUP, login: false },
          stage.childOptions(this, { provider, retainOnDelete: true })
        )
    )!;
    // Not protected, unlike the stage's other children: removing a member from the list must revoke the grant.
    for (const member of members) {
      new postgresql.GrantRole(
        `${name}-member-${member}`,
        { role: member, grantRole: OPERATORS_GROUP },
        { parent: this, provider, dependsOn: [group], ...KEEP_MEMBERSHIP }
      );
    }
    this.registerOutputs({ group: OPERATORS_GROUP, members });
  }
}
