import { NextResponse } from "next/server";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

/**
 * Map owner-wallet upstream failures (Stripe / OpenMeter / Konnect) to stable
 * HTTP responses without leaking raw provider errors to M2M callers.
 */
export function walletUpstreamErrorResponse(err: unknown, context: string): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[wallet] ${context} failed:`, sanitizeForLog(message));
  if (
    /not configured|OPENMETER_URL|STRIPE_SECRET_KEY|Cannot reach OpenMeter/i.test(message)
  ) {
    return NextResponse.json(
      { error: "Billing is not available right now" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { error: "Billing provider request failed" },
    { status: 502 },
  );
}

/** Clamp a `?page=` / `?pageSize=` query value to a sane positive integer. */
export function clampPageParam(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  const trimmed = (raw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
}
