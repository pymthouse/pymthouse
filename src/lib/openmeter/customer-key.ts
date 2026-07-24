/** Stable OpenMeter customer / event subject key for (app, external user). */
export function buildOpenMeterCustomerKey(
  clientId: string,
  externalUserId: string,
): string {
  return `${clientId.trim()}:${externalUserId.trim()}`;
}

export function parseOpenMeterCustomerKey(key: string): {
  clientId: string;
  externalUserId: string;
} | null {
  const idx = key.indexOf(":");
  if (idx <= 0 || idx >= key.length - 1) {
    return null;
  }
  return {
    clientId: key.slice(0, idx),
    externalUserId: key.slice(idx + 1),
  };
}

/**
 * Wire-only prefix for owner usage subjects inside go-livepeer `auth_id`.
 * The collector strips this before writing the CloudEvent subject; Konnect
 * customer keys use the bare platform user id.
 */
export const OWNER_CUSTOMER_KEY_PREFIX = "owner:";

/**
 * Canonical OpenMeter customer key for a platform owner: bare `{users.id}`.
 * Credits and included usage live on this single customer across all apps.
 */
export function buildOwnerCustomerKey(userId: string): string {
  return normalizePlatformUserId(userId);
}

/**
 * Transport marker for webhook → go-livepeer (`usage_subject = owner:{id}`).
 * Not the Konnect customer key — see {@link buildOwnerCustomerKey}.
 */
export function buildOwnerWireSubject(userId: string): string {
  return `${OWNER_CUSTOMER_KEY_PREFIX}${normalizePlatformUserId(userId)}`;
}

/**
 * True when `key` is an owner wallet customer key or a legacy/wire owner subject:
 * - bare `{users.id}` (canonical)
 * - `owner:{users.id}` (legacy customer key / wire subject)
 *
 * End-user customer keys are always compound `app_…:externalUserId`.
 */
export function isOwnerCustomerKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith(OWNER_CUSTOMER_KEY_PREFIX) &&
    trimmed.length > OWNER_CUSTOMER_KEY_PREFIX.length
  ) {
    return true;
  }
  // Canonical owner key has no compound separator.
  return !trimmed.includes(":");
}

/**
 * True when the value is the wire/legacy `owner:{id}` form (not a bare id).
 * Use this when classifying JWT/webhook subjects before app-owner matching —
 * bare UUIDs are common end-user external ids and must not short-circuit.
 */
export function isOwnerWireSubject(key: string): boolean {
  const trimmed = key.trim();
  return (
    trimmed.startsWith(OWNER_CUSTOMER_KEY_PREFIX) &&
    trimmed.length > OWNER_CUSTOMER_KEY_PREFIX.length
  );
}

export function parseOwnerCustomerKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith(OWNER_CUSTOMER_KEY_PREFIX)) {
    const id = trimmed.slice(OWNER_CUSTOMER_KEY_PREFIX.length);
    return id || null;
  }
  if (!trimmed.includes(":")) {
    return trimmed;
  }
  return null;
}

/**
 * Meter subjects for shared-owner usage reads: bare id first, then transitional
 * `owner:` / compound `app_…:{id}` / `app_…:owner:{id}` subjects.
 */
export function buildOwnerMeterSubjects(
  ownerUserId: string,
  publicClientIds: string[],
): string[] {
  const trimmedOwnerId = normalizePlatformUserId(ownerUserId);
  const legacyOwnerKey = buildOwnerWireSubject(trimmedOwnerId);
  const subjects = [trimmedOwnerId, legacyOwnerKey];
  for (const clientId of publicClientIds) {
    const trimmedClientId = clientId.trim();
    if (!trimmedClientId) continue;
    subjects.push(
      buildOpenMeterCustomerKey(trimmedClientId, trimmedOwnerId),
      buildOpenMeterCustomerKey(trimmedClientId, legacyOwnerKey),
    );
  }
  return [...new Set(subjects)];
}

/**
 * Normalize platform user ids from mint/device subjects:
 * `owner:{id}`, `user:{id}`, or bare `{id}` → `{id}`.
 */
export function normalizePlatformUserId(externalUserId: string): string {
  const trimmed = externalUserId.trim();
  if (trimmed.startsWith(OWNER_CUSTOMER_KEY_PREFIX)) {
    return trimmed.slice(OWNER_CUSTOMER_KEY_PREFIX.length);
  }
  if (trimmed.startsWith("user:")) {
    return trimmed.slice("user:".length);
  }
  return trimmed;
}
