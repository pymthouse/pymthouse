/** OpenMeter slug keys (features, plans, rate cards): lowercase snake_case. */
export const OPENMETER_SLUG_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export const OPENMETER_SLUG_KEY_MAX_LENGTH = 64;

export function isValidOpenMeterSlugKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= OPENMETER_SLUG_KEY_MAX_LENGTH &&
    OPENMETER_SLUG_KEY_PATTERN.test(key)
  );
}

function slugPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hash32(value: string, seed: number): string {
  let hash = 0x811c9dc5 ^ seed;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function hashSlugIdentity(parts: string[]): string {
  const value = parts.join("\0");
  return `${hash32(value, 0)}${hash32(value, 0x9e3779b9)}`;
}

/**
 * Build a key matching OpenMeter's `^[a-z0-9]+(?:_[a-z0-9]+)*$` (max 64 chars).
 */
export function toOpenMeterSlugKey(...segments: string[]): string {
  const parts = segments.map(slugPart).filter((part) => part.length > 0);
  let key = parts.join("_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  if (!key || !OPENMETER_SLUG_KEY_PATTERN.test(key)) {
    key = `om_${hashSlugIdentity(segments)}`;
  }

  if (key.length > OPENMETER_SLUG_KEY_MAX_LENGTH) {
    key = `om_${hashSlugIdentity(segments)}`;
  }

  if (!OPENMETER_SLUG_KEY_PATTERN.test(key)) {
    throw new Error(`Failed to build OpenMeter slug key from segments: ${segments.join(",")}`);
  }

  return key;
}

export function compactClientSlug(clientId: string): string {
  const part = slugPart(clientId);
  if (part.startsWith("app_") && part.length > 12) {
    return `a${part.slice(4, 12)}`;
  }
  return part.slice(0, 12);
}
