import { APIError, Forbidden } from 'payload';
import type {
  Access,
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  Payload,
} from 'payload';

import { ADMIN, BASE_ROLES, EDITOR, PREVIEW_READER, adminOnlyField, hasRole, isAdmin } from './access.js';

export const USERS_SLUG = 'users';

/**
 * The `req.context` key `seedFirstAdmin` sets. Only server code can set a request context, so no HTTP request,
 * including `/api/users/first-register` behind `/admin/create-first-user`, can carry it.
 */
export const FIRST_ADMIN_SEED_CONTEXT = 'pebbletechSeedFirstAdmin';

/**
 * Refuses every user create while the users collection is empty, unless the create carries the seed context. A fresh
 * database therefore gets its first admin only from the release job's seed, never from whoever reaches the admin first.
 */
export const firstAdminGuard: CollectionBeforeOperationHook = async ({ collection, operation, req }) => {
  if (operation !== 'create' || req.context[FIRST_ADMIN_SEED_CONTEXT] === true) return;
  const { totalDocs } = await req.payload.count({ collection: collection.slug, overrideAccess: true, req });
  if (totalDocs === 0) throw new Forbidden(req.t);
};

const selfOrAdmin: Access = ({ req }) => {
  if (hasRole(req.user, ADMIN)) return true;
  if (req.user) return { id: { equals: req.user.id } };
  return false;
};

function apiKeyOnlyFor(roles: readonly string[]): CollectionBeforeChangeHook {
  return ({ data, originalDoc }) => {
    const enabled = data.enableAPIKey ?? originalDoc?.enableAPIKey;
    const role = data.role ?? originalDoc?.role;
    if (enabled === true && !roles.includes(role)) {
      throw new APIError(`Only these roles may hold an API key: ${roles.join(', ')}`, 400);
    }
    return data;
  };
}

export interface UsersOptions {
  /**
   * Extra roles for service users that act only through an API key, such as a create-only submissions key. They
   * cannot log in to the admin.
   */
  serviceRoles?: string[];
}

/**
 * Users with `admin`, `editor` and `preview-reader` roles (plus any `serviceRoles`). Admins manage users; everyone
 * else sees and edits only themselves and cannot change a role. Only admins and editors may open the admin. API keys
 * are for the preview reader and service roles only.
 */
export function createUsersCollection(options: UsersOptions = {}): CollectionConfig {
  const serviceRoles = options.serviceRoles ?? [];
  const clash = serviceRoles.filter((role) => (BASE_ROLES as readonly string[]).includes(role));
  if (clash.length > 0) throw new Error(`serviceRoles may not repeat a base role: ${clash.join(', ')}`);
  return {
    slug: USERS_SLUG,
    auth: { useAPIKey: true },
    admin: { useAsTitle: 'email', defaultColumns: ['email', 'role'] },
    access: {
      admin: ({ req }) => hasRole(req.user, ADMIN, EDITOR),
      create: isAdmin,
      read: selfOrAdmin,
      update: selfOrAdmin,
      delete: isAdmin,
      unlock: isAdmin,
    },
    hooks: {
      beforeOperation: [firstAdminGuard],
      beforeChange: [apiKeyOnlyFor([PREVIEW_READER, ...serviceRoles])],
    },
    fields: [
      {
        name: 'role',
        type: 'select',
        required: true,
        defaultValue: EDITOR,
        saveToJWT: true,
        options: [...BASE_ROLES, ...serviceRoles],
        access: { create: adminOnlyField, update: adminOnlyField },
      },
    ],
  };
}

export interface SeedFirstAdminOptions {
  /** Default: `FIRST_ADMIN_EMAIL`. */
  email?: string;
  /** Default: `FIRST_ADMIN_PASSWORD`. */
  password?: string;
}

/**
 * For `apps/cms/src/seed.ts`, run by the release job: creates the first admin from the environment when the users
 * collection is empty, and does nothing when any user exists. The only way past `firstAdminGuard`.
 */
export async function seedFirstAdmin(
  payload: Payload,
  options: SeedFirstAdminOptions = {}
): Promise<{ created: boolean }> {
  const email = options.email ?? process.env.FIRST_ADMIN_EMAIL;
  const password = options.password ?? process.env.FIRST_ADMIN_PASSWORD;
  if (!email || !password)
    throw new Error('FIRST_ADMIN_EMAIL and FIRST_ADMIN_PASSWORD must be set to seed the first admin');
  if (password.length < 12) throw new Error('FIRST_ADMIN_PASSWORD must be at least 12 characters');
  const { totalDocs } = await payload.count({ collection: USERS_SLUG, overrideAccess: true });
  if (totalDocs > 0) return { created: false };
  await payload.create({
    collection: USERS_SLUG,
    data: { email, password, role: ADMIN },
    overrideAccess: true,
    context: { [FIRST_ADMIN_SEED_CONTEXT]: true },
  });
  return { created: true };
}
