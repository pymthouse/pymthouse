import { NextRequest, NextResponse } from "next/server";

import { runThresholdInvoiceSweep } from "@/lib/billing/threshold-invoice-worker";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Allow a full sweep under Vercel's max duration. */
export const maxDuration = 60;

/**
 * GET/POST /api/cron/threshold-invoices
 *
 * Raises gathering OpenMeter invoices that have reached the effective
 * Pay-Per-Use / app invoice threshold so Plane A (OM Stripe) or Plane C
 * (settlement Custom Invoicing) can collect.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron).
 */
function authorizeCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return false;
  }
  const header = request.headers.get("authorization")?.trim() ?? "";
  return header === `Bearer ${secret}`;
}

async function handleCron(): Promise<NextResponse> {
  try {
    const result = await runThresholdInvoiceSweep();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      "threshold-invoices cron failed:",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return handleCron();
}

export const POST = GET;
