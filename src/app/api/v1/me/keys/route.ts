import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { listSessionUserApiKeys } from "@/lib/app-api-keys";
import {
  isPersonalKeysSessionResult,
  requirePersonalKeysSession,
} from "@/lib/require-personal-keys-session";

/**
 * List API keys bound to the signed-in user across all apps.
 * Secrets are never returned — only masked prefix/suffix identifiers.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const gate = requirePersonalKeysSession(session);
  if (!isPersonalKeysSessionResult(gate)) {
    return gate;
  }

  const keys = await listSessionUserApiKeys(gate.userId);
  const activeCount = keys.filter((k) => k.status === "active").length;

  return NextResponse.json({
    keys,
    activeCount,
    totalCount: keys.length,
  });
}
