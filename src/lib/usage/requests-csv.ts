import type { SignedTicketRequestRow } from "@/lib/openmeter/signed-ticket-events";

/**
 * CSV export for the requests table.
 * Client-safe (no DB/Node imports) and pure so escaping can be unit tested.
 */

const COLUMNS = [
  "time",
  "app",
  "identity",
  "request_id",
  "pipeline",
  "model_id",
  "network_fee_usd_micros",
  "fee_wei",
  "manifest_id",
] as const;

/**
 * Escape one CSV field.
 *
 * Values that begin with a formula trigger (`= + - @`, or a leading tab/CR) are
 * prefixed with a single quote: spreadsheet apps would otherwise execute them,
 * and these fields carry operator-controlled data such as pipeline and model
 * ids. Quotes are doubled and any field containing a delimiter is wrapped.
 */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value == null) return "";
  const raw = String(value);
  if (raw === "") return "";

  const needsFormulaGuard = /^[=+\-@\t\r]/.test(raw);
  const guarded = needsFormulaGuard ? `'${raw}` : raw;

  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

/** One CSV row per request, with a header line. */
export function buildRequestsCsv(rows: SignedTicketRequestRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.time,
        row.appName || row.clientId,
        row.externalUserId,
        row.gatewayRequestId,
        row.pipeline,
        row.modelId,
        row.networkFeeUsdMicros,
        row.feeWei ?? "",
        row.manifestId ?? "",
      ]
        .map(escapeCsvField)
        .join(","),
    );
  }
  // Trailing newline so the file ends cleanly for line-oriented tools.
  return `${lines.join("\n")}\n`;
}

/** Filename like `requests-2026-07-31.csv`. */
export function buildRequestsCsvFilename(now: Date = new Date()): string {
  return `requests-${now.toISOString().slice(0, 10)}.csv`;
}

/** Sum the network fee across loaded rows (USD micros, exact). */
export function sumRequestFeeUsdMicros(rows: SignedTicketRequestRow[]): string {
  let total = 0n;
  for (const row of rows) {
    const raw = row.networkFeeUsdMicros?.trim();
    if (!raw) continue;
    try {
      // Ingest may store fractional micros; truncate toward zero for the sum.
      total += BigInt(raw.includes(".") ? raw.slice(0, raw.indexOf(".")) : raw);
    } catch {
      // Skip unparseable rows rather than breaking the footer total.
    }
  }
  return total.toString();
}
