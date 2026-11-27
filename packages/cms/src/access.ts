import type { Access, CollectionConfig, FieldAccess } from 'payload';

export const ADMIN = 'admin';
export const EDITOR = 'editor';
/** A service user whose API key lets the marketing app read drafts for preview. It cannot log in to the admin. */
export const PREVIEW_READER = 'preview-reader';
export const BASE_ROLES = [ADMIN, EDITOR, PREVIEW_READER] as const;

/** True when `user` is a logged-in user (session or API key) holding one of `roles`. */
export function hasRole(user: unknown, ...roles: string[]): boolean {
  const role = (user as { role?: unknown } | null | undefined)?.role;
  return typeof role === 'string' && roles.includes(role);
}

/** Collection or global access for the given roles only. */
export function allowRoles(...roles: string[]): Access {
  return ({ req }) => hasRole(req.user, ...roles);
}

export const anyone: Access = () => true;
export const isAdmin: Access = allowRoles(ADMIN);
/** Admins and editors: the people who use the admin panel. */
export const isStaff: Access = allowRoles(ADMIN, EDITOR);
/** The same as `isStaff`: for a collection only admins and editors may read, such as form submissions. */
export const adminOrEditorOnly: Access = isStaff;
export const adminOnlyField: FieldAccess = ({ req }) => hasRole(req.user, ADMIN);

/**
 * Read access for a collection with drafts: staff and the preview reader see every version, anyone else only
 * published documents.
 */
export const publishedOrPreview: Access = ({ req }) => {
  if (hasRole(req.user, ADMIN, EDITOR, PREVIEW_READER)) return true;
  return { _status: { equals: 'published' } };
};

/**
 * Access for a submissions collection: an API key with one of `roles` (see `serviceRoles`) may only create; reading,
 * updating and deleting are for admins and editors. Nobody else, and no public REST or GraphQL read, gets in.
 */
export function submissionAccess(...roles: string[]): NonNullable<CollectionConfig['access']> {
  if (roles.length === 0) throw new Error('submissionAccess needs at least one role that may create');
  return { create: allowRoles(...roles), read: isStaff, update: isStaff, delete: isStaff };
}
