/**
 * Registry-backed payment descriptor for LPNM `generate-live-payment`.
 * Avoids decoding legacy OrchestratorInfo for ticket-params base URL.
 */

export type RegistryGenerateLivePaymentFields = {
  recipient: string;
  ticketParamsBaseUrl: string;
  capability: string;
  offering: string;
};

function trimStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}

function pickString(
  body: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const s = trimStr(body[k]);
    if (s) return s;
  }
  return undefined;
}

export function isRegistryPaymentMode(body: Record<string, unknown>): boolean {
  const m = trimStr(body.paymentMode ?? body.PaymentMode);
  return m?.toLowerCase() === "registry";
}

export function parseRegistryGenerateLivePaymentFields(
  body: Record<string, unknown>,
):
  | { ok: true; fields: RegistryGenerateLivePaymentFields }
  | { ok: false; message: string } {
  const recipient = pickString(body, "recipient", "Recipient");
  const ticketParamsBaseUrl = pickString(
    body,
    "ticketParamsBaseUrl",
    "ticket_params_base_url",
    "TicketParamsBaseUrl",
  );
  const capability = pickString(body, "capability", "Capability");
  const offering = pickString(body, "offering", "Offering");
  if (!recipient) {
    return { ok: false, message: "registry payment requires recipient" };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return { ok: false, message: "registry recipient must be 0x-prefixed 40 hex chars" };
  }
  if (!ticketParamsBaseUrl) {
    return { ok: false, message: "registry payment requires ticketParamsBaseUrl" };
  }
  if (!capability) {
    return { ok: false, message: "registry payment requires capability" };
  }
  if (!offering) {
    return { ok: false, message: "registry payment requires offering" };
  }
  return {
    ok: true,
    fields: {
      recipient: recipient.toLowerCase(),
      ticketParamsBaseUrl: ticketParamsBaseUrl.replace(/\/+$/, ""),
      capability,
      offering,
    },
  };
}

/** Parse optional explicit wei face value for registry payments (decimal string). */
export function parseRegistryFaceValueWei(
  body: Record<string, unknown>,
): bigint | undefined {
  const raw = pickString(body, "faceValueWei", "face_value_wei", "FaceValueWei");
  if (!raw) return undefined;
  try {
    const n = BigInt(raw.trim());
    return n > 0n ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Registry-listed price per work unit (wei) for fee = workUnits * price / workUnitsPerUnit. */
export function parseRegistryPricePerUnitWei(
  body: Record<string, unknown>,
): bigint | undefined {
  const raw = pickString(
    body,
    "registryPricePerUnitWei",
    "registry_price_per_unit_wei",
    "RegistryPricePerUnitWei",
  );
  if (!raw) return undefined;
  try {
    const n = BigInt(raw.trim());
    return n >= 0n ? n : undefined;
  } catch {
    return undefined;
  }
}
