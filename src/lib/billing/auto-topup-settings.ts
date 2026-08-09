/**
 * Per-user auto top-up + app soft-negative debt ceiling.
 *
 * Charge triggers (when autoTopUpEnabled + default PM):
 * - mint_reject: SignerSession mint balance-rejected
 * - lead_soft_negative: debt enters last autoTopUpAmount of soft-negative headroom
 */

/** Runtime default charge amount when enabled and column is null ($5). */
export const DEFAULT_AUTO_TOP_UP_USD_MICROS = 5_000_000n;

export type AutoTopUpReason = "mint_reject" | "lead_soft_negative";

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

/** Soft-negative may be cleared (null) or any non-negative micros including 0. */
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
    return { ok: true, value: String(value) };
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
  return { ok: true, value: trimmed };
}

export function parseAutoTopUpUsdMicrosInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  return parsePositiveUsdMicrosInput(value, "autoTopUpUsdMicros");
}

/** Effective charge amount when auto-top-up is enabled. */
export function effectiveAutoTopUpUsdMicros(
  storedUsdMicros: string | null | undefined,
): bigint {
  if (!storedUsdMicros?.trim()) {
    return DEFAULT_AUTO_TOP_UP_USD_MICROS;
  }
  try {
    const value = BigInt(storedUsdMicros.trim());
    return value > 0n ? value : DEFAULT_AUTO_TOP_UP_USD_MICROS;
  } catch {
    return DEFAULT_AUTO_TOP_UP_USD_MICROS;
  }
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
 * Lead window: debt has entered the last `autoTopUpAmount` of soft-negative
 * headroom (still strictly below the hard ceiling for allow).
 */
export function isInAutoTopUpLeadWindow(input: {
  unbilledDebtUsdMicros: bigint;
  softNegativeUsdMicros: bigint;
  autoTopUpUsdMicros: bigint;
}): boolean {
  const soft = input.softNegativeUsdMicros;
  const amount = input.autoTopUpUsdMicros;
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
