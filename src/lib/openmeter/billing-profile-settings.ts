/** Parse optional invoice threshold (USD micros string) or null to clear. */
export function parseInvoiceThresholdUsdMicrosInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === "") {
    return { ok: true, value: null };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      return {
        ok: false,
        error: "invoiceThresholdUsdMicros must be a non-negative integer or null",
      };
    }
    return { ok: true, value: String(value) };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: "invoiceThresholdUsdMicros must be a non-negative integer micros string or null",
    };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: "invoiceThresholdUsdMicros must be a non-negative integer micros string or null",
    };
  }
  return { ok: true, value: trimmed };
}

export { parseSoftNegativeUsdMicrosInput } from "@/lib/billing/auto-topup-settings";

export function parseProgressiveBillingInput(
  value: unknown,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof value !== "boolean") {
    return { ok: false, error: "progressiveBilling must be a boolean" };
  }
  return { ok: true, value };
}
