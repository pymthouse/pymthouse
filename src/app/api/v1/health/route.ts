import { NextResponse } from "next/server";
import { getHealthStatus } from "@/domains/signer-runtime/runtime/health";

export async function GET() {
  try {
    return NextResponse.json(await getHealthStatus());
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 503 }
    );
  }
}
