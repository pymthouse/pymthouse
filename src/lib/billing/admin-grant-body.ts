import type { GrantSource } from "@/lib/billing/types";

const ADMIN_GRANT_SOURCES = new Set<GrantSource>([
  "manual",
  "promo",
  "plan_adjustment",
]);

export type ParsedAdminGrantBody = {
  amountUsdMicros: bigint;
  note: string;
  source: GrantSource;
};

function parsePositiveAmountUsdMicros(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  try {
    const parsed = BigInt(normalized);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function parseAdminGrantBody(
  body: unknown,
): { ok: true; value: ParsedAdminGrantBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid JSON body" };
  }
  const record = body as Record<string, unknown>;
  const amountUsdMicros = parsePositiveAmountUsdMicros(record.amountUsdMicros);
  if (!amountUsdMicros) {
    return { ok: false, error: "amountUsdMicros must be positive" };
  }
  const note = typeof record.note === "string" ? record.note.trim() : "";
  if (!note) {
    return { ok: false, error: "note is required" };
  }
  const sourceRaw =
    typeof record.source === "string" ? record.source.trim() : "manual";
  if (!ADMIN_GRANT_SOURCES.has(sourceRaw as GrantSource)) {
    return {
      ok: false,
      error: "source must be one of: manual, promo, plan_adjustment",
    };
  }
  return {
    ok: true,
    value: {
      amountUsdMicros,
      note,
      source: sourceRaw as GrantSource,
    },
  };
}
