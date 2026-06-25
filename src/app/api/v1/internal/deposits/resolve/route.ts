import { NextResponse } from "next/server";
import { resolveDepositAttribution } from "@/lib/turnkey/resolve-deposit-payer";
import { normalizeWalletAddress } from "@/lib/turnkey";

function verifyIngestSecret(request: Request): boolean {
  const expected = process.env.INGEST_SHARED_SECRET?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return false;
  }
  return auth.slice(7).trim() === expected;
}

/**
 * GET /api/v1/internal/deposits/resolve?from=0x...
 *
 * Internal read-only deposit attribution for clearinghouse.
 */
export async function GET(request: Request) {
  if (!verifyIngestSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const fromRaw = new URL(request.url).searchParams.get("from");
  const fromAddress = normalizeWalletAddress(fromRaw);
  if (!fromAddress) {
    return NextResponse.json(
      { error: "Query parameter from must be a valid EVM address" },
      { status: 400 },
    );
  }

  const attribution = await resolveDepositAttribution(fromAddress);
  if (!attribution) {
    return NextResponse.json({ error: "No attribution for address" }, { status: 404 });
  }

  return NextResponse.json(attribution);
}
