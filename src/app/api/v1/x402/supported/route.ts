import { NextResponse } from "next/server";
import { listSupportedKinds, getFacilitatorAccount } from "@/lib/x402";

/**
 * GET /api/v1/x402/supported — public discovery of schemes/networks.
 */
export async function GET() {
  let signers: { eip155?: string[] } = {};
  try {
    const account = getFacilitatorAccount();
    signers = { eip155: [account.address] };
  } catch {
    signers = {};
  }

  return NextResponse.json({
    kinds: listSupportedKinds(),
    extensions: [],
    signers,
  });
}
