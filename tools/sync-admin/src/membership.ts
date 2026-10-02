export interface MembershipRecord {
  startedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  maxBytes: number;
  revision: number;
  planId?: string | null;
  planVersion?: string | null;
}
export interface MembershipRow {
  membership_started_at: string | null;
  membership_expires_at: string | null;
  membership_revoked_at: string | null;
  membership_max_bytes: number | null;
  membership_revision: number | null;
  membership_plan_id?: string | null;
  membership_plan_version?: string | null;
}
export const MEMBERSHIP_FIELDS = ['started_at', 'expires_at', 'revoked_at', 'max_bytes', 'revision'] as const;
export function membershipProjection(available: boolean, plansAvailable = false) {
  return [
    ...MEMBERSHIP_FIELDS.map((name) => `${available ? `m.${name}` : 'NULL'} AS membership_${name}`),
    `${available && plansAvailable ? 'm.plan_id' : 'NULL'} AS membership_plan_id`,
    `${available && plansAvailable ? 'm.plan_version' : 'NULL'} AS membership_plan_version`,
  ].join(',');
}
export function readMembership(row: MembershipRow): MembershipRecord | null {
  if (row.membership_started_at === null) return null;
  return {
    startedAt: row.membership_started_at,
    expiresAt: row.membership_expires_at ?? '',
    revokedAt: row.membership_revoked_at,
    maxBytes: row.membership_max_bytes ?? 0,
    revision: row.membership_revision ?? 0,
    planId: row.membership_plan_id ?? null,
    planVersion: row.membership_plan_version ?? null,
  };
}
export function presentMembership(member: MembershipRecord | null, now: number) {
  if (!member) return null;
  const active = Date.parse(member.startedAt) <= now && now < Date.parse(member.expiresAt);
  return {
    status: member.revokedAt !== null ? 'revoked' : active ? 'active' : 'expired',
    startedAt: member.startedAt,
    expiresAt: member.expiresAt,
    revokedAt: member.revokedAt,
    maxBytes: member.maxBytes,
    planId: member.planId ?? null,
    planVersion: member.planVersion ?? null,
  };
}
export function effectiveQuota(manual: number | null, member: MembershipRecord | null, base: number, now: number) {
  const membership = presentMembership(member, now);
  const active = membership?.status === 'active';
  return {
    membership,
    quotaLimitBytes: manual ?? (active ? membership.maxBytes : base),
    quotaSource: manual !== null ? 'manual' : active ? 'vip' : 'default',
  };
}
