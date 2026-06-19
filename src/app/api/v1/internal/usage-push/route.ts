import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { runUsageIngestPushJob } from "@/lib/bpp/usage-push-job";

/** Cron route: always runs dynamically (reads request headers, hits the DB). */
export const dynamic = "force-dynamic";

/**
 * Constant-time secret comparison. Both inputs are operator-configured (not user
 * input), but a timing-safe compare avoids leaking the secret length/prefix.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Authorize the scheduled trigger. Accepts the Vercel Cron bearer
 * (`USAGE_PUSH_CRON_SECRET`, falling back to the platform `CRON_SECRET`). When
 * no secret is configured, allow only outside production — same posture as the
 * internal signed-ticket ingest route.
 */
function authorizeCron(request: NextRequest): boolean {
  const expected =
    process.env.USAGE_PUSH_CRON_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return false;
  }
  return secretsMatch(auth.slice(7).trim(), expected);
}

/**
 * Scheduled BPP ⑥ usage push (Vercel Cron). Gated behind `USAGE_INGEST_PUSH`
 * (default OFF): when the flag is off the job is a strict no-op and this route
 * returns `{ ok: true, enabled: false }` without touching the DB or network, so
 * the scheduler stays green while the seam is dormant.
 */
export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const correlationId = request.headers.get("x-request-id") || undefined;

  try {
    const summary = await runUsageIngestPushJob({ correlationId });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.name : "usage_push_failed",
      },
      { status: 500 },
    );
  }
}
