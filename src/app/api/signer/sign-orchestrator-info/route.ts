import { NextRequest, NextResponse } from "next/server";
import {
  authenticateRequestAsync,
  hasScope,
  AuthError,
} from "@/domains/identity-access/runtime/request-auth";
import { proxySignOrchestratorInfo } from "@/domains/signer-runtime/runtime/signer-proxy";

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestAsync(request);
    if (!auth) {
      return NextResponse.json(
        { error: "Unauthorized: invalid or expired token" },
        { status: 401 }
      );
    }

    if (!hasScope(auth.scopes, "sign:job")) {
      return NextResponse.json(
        {
          error: "insufficient_scope",
          error_description: "sign:job scope is required",
        },
        { status: 403 }
      );
    }

    const body = await request.json();
    const result = await proxySignOrchestratorInfo(body, auth);

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error("[api] sign-orchestrator-info error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
