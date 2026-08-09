export {
  parseInvoiceLeadUsdMicrosInput,
  parseSoftNegativeUsdMicrosInput,
} from "@/lib/billing/overage-limits";

export function parseProgressiveBillingInput(
  value: unknown,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof value !== "boolean") {
    return { ok: false, error: "progressiveBilling must be a boolean" };
  }
  return { ok: true, value };
}
