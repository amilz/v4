import type { Permissions } from './generated';

export const Permission = {
  Initiate: 0b0000_0001,
  Vote: 0b0000_0010,
  Execute: 0b0000_0100,
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/** Builds a `Permissions` mask from a list of permissions. */
export function createPermissions(permissions: readonly Permission[]): Permissions {
  return { mask: permissions.reduce<number>((mask, permission) => mask | permission, 0) };
}

/** Builds a `Permissions` mask with every permission set. */
export function allPermissions(): Permissions {
  return createPermissions(Object.values(Permission));
}

/** Whether `permissions` includes `permission`. */
export function hasPermission(permissions: Permissions, permission: Permission): boolean {
  return (permissions.mask & permission) === permission;
}
