export const ORG_ROLES = ['owner', 'admin', 'billing', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const OPERATOR_ROLES = ['operator_support', 'operator_finance', 'operator_admin'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export type OrgPermission =
  | 'org.read'
  | 'org.manage'
  | 'members.manage'
  | 'billing.read'
  | 'billing.manage'
  | 'services.read'
  | 'services.manage'
  | 'support.use';

const MATRIX: Record<OrgRole, readonly OrgPermission[]> = {
  owner: ['org.read', 'org.manage', 'members.manage', 'billing.read', 'billing.manage', 'services.read', 'services.manage', 'support.use'],
  admin: ['org.read', 'org.manage', 'members.manage', 'billing.read', 'services.read', 'services.manage', 'support.use'],
  billing: ['org.read', 'billing.read', 'billing.manage', 'services.read', 'support.use'],
  member: ['org.read', 'services.read', 'support.use'],
};

export function roleHasPermission(role: OrgRole, permission: OrgPermission): boolean {
  return MATRIX[role].includes(permission);
}

/** Only owners can grant owner; admins can manage non-owner roles. */
export function canAssignRole(actor: OrgRole, target: OrgRole): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return target !== 'owner';
  return false;
}
