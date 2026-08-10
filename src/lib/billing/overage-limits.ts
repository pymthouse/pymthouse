/**
 * Soft-negative debt ceiling + mid-cycle invoice trigger lead window.
 *
 * Soft-negative gates mint/signer allow/deny. The invoice trigger (OM
 * invoicePendingLines → settlement / Stripe app) fires in the lead window
 * before the hard ceiling so collection stays async with headroom.
 *
 * This is the amount-based half of collection. Time-based collection is
 * OpenMeter's, via the billing profile's anchored collection alignment; OM has
 * no amount threshold, which is why the lead window lives here.
 */

/**
 * Stripe's minimum USD card charge. An invoice below this cannot be collected,
 * so raising one only produces a stuck draft.
 */
export const MIN_INVOICE_USD_MICROS = 500_000n;

/**
 * Smallest positive debt ceiling we accept. The raise floor plus enough
 * headroom for an invoice to be raised, settled and cleared before the gate
 * locks the subject out. Below this the account can deadlock: debt reaches the
 * ceiling while every invoice raised along the way is too small to charge.
 */
export const MIN_SOFT_NEGATIVE_USD_MICROS = 2_000_000n;

/** Upper bound on the derived lead window ($5). */
export const MAX_INVOICE_TRIGGER_LEAD_USD_MICROS = 5_000_000n;

export function parsePositiveUsdMicrosInput(
  value: unknown,
  fieldName: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === "") {
    return { ok: true, value: null };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      return {
        ok: false,
        error: `${fieldName} must be a positive integer micros or null`,
      };
    }
    return { ok: true, value: String(value) };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: `${fieldName} must be a positive integer micros string or null`,
    };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `${fieldName} must be a positive integer micros string or null`,
    };
  }
  try {
    if (BigInt(trimmed) <= 0n) {
      return {
        ok: false,
        error: `${fieldName} must be greater than 0`,
      };
    }
  } catch {
    return {
      ok: false,
      error: `${fieldName} must be a positive integer micros string or null`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * A positive ceiling must clear MIN_SOFT_NEGATIVE_USD_MICROS. Zero stays legal
 * and means "no ceiling", so it is not held to the floor.
 */
function enforceCeilingFloor(
  micros: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const parsed = BigInt(micros);
  if (parsed > 0n && parsed < MIN_SOFT_NEGATIVE_USD_MICROS) {
    return {
      ok: false,
      error: `softNegativeUsdMicros must be 0 (no ceiling) or at least ${MIN_SOFT_NEGATIVE_USD_MICROS} micros ($${(Number(MIN_SOFT_NEGATIVE_USD_MICROS) / 1_000_000).toFixed(2)}); smaller ceilings cannot be collected before the gate denies`,
    };
  }
  return { ok: true, value: micros };
}

/** Soft-negative may be cleared (null), 0 (no ceiling), or at least the floor. */
export function parseSoftNegativeUsdMicrosInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === "") {
    return { ok: true, value: null };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      return {
        ok: false,
        error: "softNegativeUsdMicros must be a non-negative integer or null",
      };
    }
    return enforceCeilingFloor(String(value));
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error:
        "softNegativeUsdMicros must be a non-negative integer micros string or null",
    };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error:
        "softNegativeUsdMicros must be a non-negative integer micros string or null",
    };
  }
  return enforceCeilingFloor(trimmed);
}

/** Lead window override: cleared (null) or a positive micros amount. */
export function parseInvoiceLeadUsdMicrosInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  return parsePositiveUsdMicrosInput(value, "invoiceLeadUsdMicros");
}

/**
 * App soft-negative unbilled-debt ceiling.
 * Unset/null/invalid ⇒ 0 (no ceiling — overage eligibility alone unlocks past
 * prepaid $0). Set a positive value to deny mint/signer once unbilled debt
 * reaches that micros amount.
 */
export function effectiveSoftNegativeUsdMicros(
  storedUsdMicros: string | null | undefined,
): bigint {
  if (!storedUsdMicros?.trim()) {
    return 0n;
  }
  try {
    const value = BigInt(storedUsdMicros.trim());
    return value >= 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Lead window for the amount-based raise.
 *
 * Defaults to half the ceiling capped at MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
 * so a $2 ceiling raises at $1 of debt and a $10 ceiling still raises at $5.
 * A stored per-app override wins when set.
 */
export function effectiveInvoiceLeadUsdMicros(input: {
  storedUsdMicros: string | null | undefined;
  softNegativeUsdMicros: bigint;
}): bigint {
  const stored = input.storedUsdMicros?.trim();
  if (stored) {
    try {
      const value = BigInt(stored);
      if (value > 0n) {
        return value;
      }
    } catch {
      // Fall through to the derived default.
    }
  }
  const ceiling = input.softNegativeUsdMicros;
  if (ceiling <= 0n) {
    return MAX_INVOICE_TRIGGER_LEAD_USD_MICROS;
  }
  const half = ceiling / 2n;
  return half < MAX_INVOICE_TRIGGER_LEAD_USD_MICROS
    ? half
    : MAX_INVOICE_TRIGGER_LEAD_USD_MICROS;
}

/**
 * Lead window: debt has entered the last `leadUsdMicros` of soft-negative
 * headroom (still strictly below the hard ceiling for allow).
 */
export function isInInvoiceTriggerLeadWindow(input: {
  unbilledDebtUsdMicros: bigint;
  softNegativeUsdMicros: bigint;
  leadUsdMicros: bigint;
}): boolean {
  const soft = input.softNegativeUsdMicros;
  const amount = input.leadUsdMicros;
  if (amount <= 0n) return false;
  const leadStart = soft > amount ? soft - amount : 0n;
  return (
    input.unbilledDebtUsdMicros >= leadStart &&
    input.unbilledDebtUsdMicros < soft
  );
}

/**
 * Pure gate: may continue at spendable ≤ 0 given overage + optional debt ceiling.
 * Soft-negative `0` means no ceiling (overage alone allows past prepaid zero).
 */
export function softNegativeAllowsContinue(input: {
  spendableUsdMicros: bigint;
  allowsOverageInvoicing: boolean;
  unbilledDebtUsdMicros: bigint;
  softNegativeUsdMicros: bigint;
}): boolean {
  if (input.spendableUsdMicros > 0n) {
    return true;
  }
  if (!input.allowsOverageInvoicing) {
    return false;
  }
  // No positive ceiling configured → overage unlocks past prepaid $0.
  if (input.softNegativeUsdMicros <= 0n) {
    return true;
  }
  return input.unbilledDebtUsdMicros < input.softNegativeUsdMicros;
}
