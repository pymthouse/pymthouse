import { NextResponse } from "next/server";
import { getEthUsdOracle } from "@/platform/ops/prices/eth-usd-oracle";

export async function GET() {
  const ethUsd = await getEthUsdOracle();
  const cacheControl = ethUsd.isFallback
    ? "no-store"
    : "public, max-age=60, stale-while-revalidate=30";

  return NextResponse.json(
    { ethUsd },
    {
      headers: {
        "Cache-Control": cacheControl,
      },
    },
  );
}
