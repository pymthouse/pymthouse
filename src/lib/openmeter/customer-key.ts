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
 * Map go-livepeer Kafka `auth_id` to OpenMeter CloudEvent subject + meter dimensions.
 * Compound keys (`client:external`) match {@link buildOpenMeterCustomerKey}; opaque strings
 * use the full auth_id for subject and both groupBy dimensions.
 */
export function openMeterDimensionsFromAuthId(authId: string): {
  subject: string;
  clientId: string;
  externalUserId: string;
} | null {
  const subject = authId.trim();
  if (!subject) {
    return null;
  }
  const parsed = parseOpenMeterCustomerKey(subject);
  if (parsed) {
    return {
      subject,
      clientId: parsed.clientId,
      externalUserId: parsed.externalUserId,
    };
  }
  return {
    subject,
    clientId: subject,
    externalUserId: subject,
  };
}
