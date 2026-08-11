/**
 * Shared supplier identity for OpenMeter / Konnect billing profiles.
 *
 * The supplier is who is legally selling on an invoice. Platform profiles use
 * {@link platformSupplierCountryCode}; Connect merchant profiles sync from the
 * connected Stripe account (see supplier-sync.ts).
 */

export function platformSupplierCountryCode(): string {
  const raw = process.env.OPENMETER_BILLING_SUPPLIER_COUNTRY?.trim() || "US";
  return raw.toUpperCase();
}

export type BillingProfileSupplierInput = {
  country?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  addressPostalCode?: string | null;
  taxId?: string | null;
};

function present(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Drop absent keys so OpenMeter never receives `{"city": null}`. */
function compact(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, v]) => present(v))
      .map(([k, v]) => [k, (v as string).trim()]),
  );
}

function resolvedCountry(s?: BillingProfileSupplierInput): string {
  const c = s?.country?.trim();
  return c ? c.toUpperCase() : platformSupplierCountryCode();
}

/** OSS OpenMeter `Address`. */
export function buildOpenMeterSupplierAddress(s?: BillingProfileSupplierInput) {
  return compact({
    country: resolvedCountry(s),
    line1: s?.addressLine1,
    line2: s?.addressLine2,
    city: s?.addressCity,
    state: s?.addressState,
    postalCode: s?.addressPostalCode,
  });
}

/** Konnect nests the same values under billing_address with snake_case keys. */
export function buildKonnectSupplierAddress(s?: BillingProfileSupplierInput) {
  return compact({
    country: resolvedCountry(s),
    line1: s?.addressLine1,
    line2: s?.addressLine2,
    city: s?.addressCity,
    state: s?.addressState,
    postal_code: s?.addressPostalCode,
  });
}

/**
 * Jurisdictions that expect a seller tax number on B2B invoices.
 * Stripe Connect only exposes `tax_id_provided` (boolean) — never the value —
 * so {@link supplierGaps} treats on-file-at-Stripe as satisfying the gap.
 *
 * First-pass list — have tax counsel review before gating production onboarding.
 */
const TAX_ID_REQUIRED_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "GB",
  "NO",
  "CH",
  "AU",
  "NZ",
  "SG",
  "ZA",
  "AE",
  "SA",
  "IN",
]);

export function requiresSupplierTaxId(country?: string | null): boolean {
  const code = country?.trim().toUpperCase();
  return code ? TAX_ID_REQUIRED_COUNTRIES.has(code) : false;
}

export type SupplierGap = "country" | "name" | "tax_id";

export function supplierGaps(input: {
  country?: string | null;
  name?: string | null;
  taxId?: string | null;
  /** Stripe Connect `company.tax_id_provided` / `vat_id_provided`. */
  taxIdOnFileAtStripe?: boolean | null;
}): SupplierGap[] {
  const gaps: SupplierGap[] = [];
  if (!present(input.country)) gaps.push("country");
  if (!present(input.name)) gaps.push("name");
  const hasTaxId =
    present(input.taxId) || Boolean(input.taxIdOnFileAtStripe);
  if (requiresSupplierTaxId(input.country) && !hasTaxId) {
    gaps.push("tax_id");
  }
  return gaps;
}

export function supplierIsComplete(
  input: Parameters<typeof supplierGaps>[0],
): boolean {
  return supplierGaps(input).length === 0;
}
