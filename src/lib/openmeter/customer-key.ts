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
