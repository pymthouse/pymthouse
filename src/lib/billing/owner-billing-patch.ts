/**
 * Pure parsers for admin owner-billing PATCH bodies.
 * Kept out of the route handler so validation is unit-testable and the route
 * stays under Sonar cognitive-complexity limits.
 */

export type OwnerBillingPatch = {
  starterIncludedUsdMicros?: string | null;
  endUserCap?: number | null;
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
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      return {
        ok: false,
        error: "starterIncludedUsdMicros must be a non-negative integer string or null",
      };
    }
    return { ok: true, value: String(raw) };
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

function parseNote(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false, error: "note must be a string or null" };
}

/** Parse a JSON body into a sparse owner-billing patch. */
export function parseOwnerBillingPatchBody(
  body: unknown,
): OwnerBillingPatchParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid JSON body" };
  }
  const record = body as Record<string, unknown>;

  if ("applicationFeeBps" in record) {
    return {
      ok: false,
      error:
        "applicationFeeBps is not an owner override; set Connect platform fees on the app billing path",
    };
  }

  const patch: OwnerBillingPatch = {};

  if ("starterIncludedUsdMicros" in record) {
    const parsed = parseStarterMicros(record.starterIncludedUsdMicros);
    if (!parsed.ok) return parsed;
    patch.starterIncludedUsdMicros = parsed.value;
  }

  if ("endUserCap" in record) {
    const parsed = parseEndUserCap(record.endUserCap);
    if (!parsed.ok) return parsed;
    patch.endUserCap = parsed.value;
  }

  if ("note" in record) {
    const parsed = parseNote(record.note);
    if (!parsed.ok) return parsed;
    patch.note = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "No recognized fields to update" };
  }
  return { ok: true, patch };
}
