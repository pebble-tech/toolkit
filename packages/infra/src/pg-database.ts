// Drop or check one database and its role, on any Postgres (local, a
// CI service, or a shared PlanetScale cluster). `pebble-infra` runs this file with `node`; nothing imports it, so
// `pg` loads only here. It has no relative import, so Node runs the .ts source as it is in this package's tests.
//
//   pebble-infra pg-database drop <name> [--owner <role>]
//       drops the database and, unless --owner was given, its role.
//   pebble-infra pg-database check <name> [--owner <role>]
//       exits 3 with one line naming who can, when the admin could not drop them (another admin created the role);
//       0 otherwise. drop checks first.
//
// Needs PG_ADMIN_URL: a role with CREATEDB and CREATEROLE (never deployed).
import pg from 'pg';

const args = process.argv.slice(2);
const command = args[0];
const name = args[1];
const ownerIndex = args.indexOf('--owner');
/** `--owner <role>`: an existing role that owns the database; drop keeps it. */
const owner = ownerIndex === -1 ? undefined : args[ownerIndex + 1];
const existingOwner = owner !== undefined;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

if (
  !['drop', 'check'].includes(command ?? '') ||
  !name ||
  !IDENTIFIER.test(name) ||
  (ownerIndex !== -1 && !IDENTIFIER.test(owner ?? ''))
) {
  process.stderr.write('usage: pebble-infra pg-database <drop|check> <name> [--owner <role>]\n');
  process.exit(2);
}

const adminUrl = process.env.PG_ADMIN_URL?.trim();
if (!adminUrl) {
  process.stderr.write('Missing PG_ADMIN_URL\n');
  process.exit(2);
}

const role = owner ?? name;
const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;

interface Holder {
  role: string;
  owns_database: boolean;
  acts: boolean;
  administers: boolean;
  administrators: string | null;
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  // DROP DATABASE needs the owner's privileges and DROP ROLE needs ADMIN OPTION on the role. The admin made the role,
  // so it holds ADMIN OPTION on it, but the membership that lets it act as the owner can be gone (a replaced
  // postgresql GrantRole revokes it): it grants that back to itself. A role another admin made gives it neither.
  const { rows } = await client.query<Holder>(
    `select r.rolname as role,
            d.datname is not null as owns_database,
            pg_has_role(current_user, r.oid, 'usage') as acts,
            (select rolsuper from pg_roles where rolname = current_user)
              or exists (select from pg_auth_members m
                         where m.roleid = r.oid and m.member = (select oid from pg_roles where rolname = current_user)
                           and m.admin_option) as administers,
            (select string_agg(pg_get_userbyid(m.member), ', ' order by pg_get_userbyid(m.member))
               from pg_auth_members m where m.roleid = r.oid and m.admin_option) as administrators
       from pg_roles r left join pg_database d on d.datdba = r.oid and d.datname = $1
      where r.oid = (select datdba from pg_database where datname = $1) or r.rolname = $2`,
    [name, existingOwner ? '' : role]
  );
  // The database's owner needs acting as (or ADMIN OPTION, to grant that); the role this command drops needs ADMIN
  // OPTION.
  const allowed = (row: Holder) =>
    (!row.owns_database || row.acts || row.administers) && (existingOwner || row.role !== role || row.administers);
  const blocked = rows.find((row) => !allowed(row));
  if (blocked) {
    const admin = (await client.query<{ me: string }>('select current_user as me')).rows[0]!.me;
    process.stderr.write(
      `refusing: ${admin} cannot drop database ${name}${existingOwner ? '' : ` and role ${role}`}: it holds no ADMIN OPTION on role ${blocked.role}${blocked.owns_database && !blocked.acts ? ', the owner, and cannot act as it' : ''}; ADMIN OPTION on ${blocked.role} is held by ${blocked.administrators ?? 'no role'}. Rerun with that admin's PG_ADMIN_URL (the one in use when ${blocked.role} was created), or have an admin with ADMIN OPTION on ${blocked.role} drop them; the Pulumi state is kept for that cleanup.\n`
    );
    process.exitCode = 3;
  } else if (command === 'drop') {
    for (const row of rows) {
      if (row.owns_database && !row.acts) {
        await client.query(`grant ${ident(row.role)} to current_user with inherit true, set true`);
      }
    }
    await client.query(`drop database if exists ${ident(name)} with (force)`);
    if (!existingOwner) await client.query(`drop role if exists ${ident(role)}`);
    process.stderr.write(`dropped database ${name}${existingOwner ? '' : ` and role ${role}`}\n`);
  }
} finally {
  await client.end();
}
