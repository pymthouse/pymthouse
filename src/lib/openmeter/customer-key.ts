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

/** Platform owner OpenMeter customer key (shared across all apps they own). */
export const OWNER_CUSTOMER_KEY_PREFIX = "owner:";

export function buildOwnerCustomerKey(userId: string): string {
  return `${OWNER_CUSTOMER_KEY_PREFIX}${userId.trim()}`;
}

export function isOwnerCustomerKey(key: string): boolean {
  const trimmed = key.trim();
  return (
    trimmed.startsWith(OWNER_CUSTOMER_KEY_PREFIX) &&
    trimmed.length > OWNER_CUSTOMER_KEY_PREFIX.length
  );
}

export function parseOwnerCustomerKey(key: string): string | null {
  if (!isOwnerCustomerKey(key)) {
    return null;
  }
  return key.trim().slice(OWNER_CUSTOMER_KEY_PREFIX.length);
}

/**
 * Meter subjects for shared-owner usage reads: compound wire keys plus
 * transitional owner: / app_…:owner:… subjects.
 */
export function buildOwnerMeterSubjects(
  ownerUserId: string,
  publicClientIds: string[],
): string[] {
  const trimmedOwnerId = ownerUserId.trim();
  const ownerKey = buildOwnerCustomerKey(trimmedOwnerId);
  const subjects = [ownerKey];
  for (const clientId of publicClientIds) {
    const trimmedClientId = clientId.trim();
    if (!trimmedClientId) continue;
    subjects.push(
      buildOpenMeterCustomerKey(trimmedClientId, trimmedOwnerId),
      buildOpenMeterCustomerKey(trimmedClientId, ownerKey),
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
