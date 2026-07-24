export type ManifestCapability = {
  pipeline: string;
  modelId: string;
};

export function capabilityAllowKeys(
  capabilities: ManifestCapability[],
): Set<string> {
  const keys = new Set<string>();
  for (const { pipeline, modelId } of capabilities) {
    keys.add(`${pipeline}|${modelId}`);
    keys.add(`${pipeline}:${modelId}`);
    if (modelId === "*") {
      keys.add(`${pipeline}|*`);
      keys.add(`${pipeline}:*`);
    }
  }
  return keys;
}

export function isCapabilityAllowed(
  capability: string,
  allow: Set<string>,
): boolean {
  const trimmed = capability.trim();
  if (!trimmed) return false;
  if (allow.has(trimmed)) return true;
  const normalized = trimmed.replace(":", "|");
  if (allow.has(normalized)) return true;
  const pipeIdx = normalized.indexOf("|");
  if (pipeIdx > 0) {
    const pipeline = normalized.slice(0, pipeIdx);
    if (allow.has(`${pipeline}|*`) || allow.has(`${pipeline}:*`)) {
      return true;
    }
  }
  return false;
}

export function filterAllowedCapabilities(
  requested: string[],
  manifestCapabilities: ManifestCapability[],
): string[] {
  const allow = capabilityAllowKeys(manifestCapabilities);
  return requested.filter((c) => isCapabilityAllowed(c, allow));
}
