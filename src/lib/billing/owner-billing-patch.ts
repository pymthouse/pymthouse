/**
 * Pure parsers for admin owner-billing PATCH bodies.
 * Kept out of the route handler so validation is unit-testable and the route
 * stays under Sonar cognitive-complexity limits.
 */

export type OwnerBillingPatch = {
  starterIncludedUsdMicros?: string | null;
  endUserCap?: number | null;
  applicationFeeBps?: number | null;
  note?: string | null;
};

export type OwnerBillingPatchParseResult =
  | { ok: true; patch: OwnerBillingPatch }
  | { ok: false; error: string };

function parseStarterMicros(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed && !/^\d+$/.test(trimmed)) {
      return {
        ok: false,
        error: "starterIncludedUsdMicros must be a non-negative integer string or null",
      };
    }
    return { ok: true, value: trimmed || null };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { ok: true, value: String(Math.trunc(raw)) };
  }
  return {
    ok: false,
    error: "starterIncludedUsdMicros must be a non-negative integer string or null",
  };
}

function parseEndUserCap(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return { ok: true, value: raw };
  }
  return { ok: false, error: "endUserCap must be a positive integer or null" };
}

function parseApplicationFeeBps(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= 10_000
  ) {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: "applicationFeeBps must be an integer in [0, 10000] or null",
  };
}

function parseNote(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false, error: "note must be a string or null" };
}

/** Parse a JSON body into a sparse owner-billing patch. */
export function parseOwnerBillingPatchBody(
  body: Record<string, unknown>,
): OwnerBillingPatchParseResult {
  const patch: OwnerBillingPatch = {};

  if ("starterIncludedUsdMicros" in body) {
    const parsed = parseStarterMicros(body.starterIncludedUsdMicros);
    if (!parsed.ok) return parsed;
    patch.starterIncludedUsdMicros = parsed.value;
  }

  if ("endUserCap" in body) {
    const parsed = parseEndUserCap(body.endUserCap);
    if (!parsed.ok) return parsed;
    patch.endUserCap = parsed.value;
  }

  if ("applicationFeeBps" in body) {
    const parsed = parseApplicationFeeBps(body.applicationFeeBps);
    if (!parsed.ok) return parsed;
    patch.applicationFeeBps = parsed.value;
  }

  if ("note" in body) {
    const parsed = parseNote(body.note);
    if (!parsed.ok) return parsed;
    patch.note = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "No recognized fields to update" };
  }
  return { ok: true, patch };
}
