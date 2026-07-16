/** Pure parsing for NaaP composite bearer `app_<publicClientId>.pmth_<secret>`. */

const COMPOSITE_PMTH_SEPARATOR = ".pmth_";

export type CompositeAppApiKeyParts = {
  publicClientId: string;
  pmthSecret: string;
};

export function parseCompositeAppApiKeyBearer(
  token: string,
): CompositeAppApiKeyParts | null {
  const trimmed = token.trim();
  const idx = trimmed.indexOf(COMPOSITE_PMTH_SEPARATOR);
  if (idx <= 0) {
    return null;
  }

  const publicClientId = trimmed.slice(0, idx).trim();
  const secretSuffix = trimmed.slice(idx + COMPOSITE_PMTH_SEPARATOR.length).trim();
  if (!publicClientId.startsWith("app_") || !secretSuffix) {
    return null;
  }

  return {
    publicClientId,
    pmthSecret: `pmth_${secretSuffix}`,
  };
}
