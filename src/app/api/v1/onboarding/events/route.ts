import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";

const ALLOWED = new Set([
  "onboarding_started",
  "onboarding_resumed",
  "persona_selected",
  "explorer_joined",
  "explorer_key_minted",
  "network_key_minted",
  "builder_app_created",
  "builder_key_minted",
  "onboarding_completed",
  "onboarding_soft_skipped",
]);

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";
  if (!ALLOWED.has(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const correlationId = createCorrelationId();
  await writeAuditLog({
    actorUserId: userId,
    action,
    status: "ok",
    correlationId,
    metadata: {
      step: typeof body.step === "string" ? body.step : null,
      persona: typeof body.persona === "string" ? body.persona : null,
    },
  });

  return NextResponse.json({ ok: true, correlation_id: correlationId });
}
