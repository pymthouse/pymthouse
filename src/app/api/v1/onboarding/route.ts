import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import {
  getOnboardingStatus,
  setUserPersona,
  softSkipBuilderOnboarding,
  type OnboardingPersona,
} from "@/lib/onboarding";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const status = await getOnboardingStatus(userId);
  return NextResponse.json(status);
}

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
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "persona must be explorer or builder" },
      { status: 400 },
    );
  }
  const record = body as { persona?: unknown; softSkip?: unknown };
  const persona = record.persona as string | undefined;
  const softSkip = record.softSkip === true;

  if (persona !== "explorer" && persona !== "builder") {
    return NextResponse.json(
      { error: "persona must be explorer or builder" },
      { status: 400 },
    );
  }

  const typedPersona = persona as OnboardingPersona;
  const correlationId = createCorrelationId();

  if (softSkip) {
    if (typedPersona !== "builder") {
      return NextResponse.json(
        { error: "softSkip is only supported for the Builder path" },
        { status: 400 },
      );
    }
    await softSkipBuilderOnboarding(userId);
    await writeAuditLog({
      actorUserId: userId,
      action: "onboarding_soft_skipped",
      status: "ok",
      correlationId,
      metadata: { persona: "builder" },
    });
    return NextResponse.json({
      persona: "builder",
      softSkipped: true,
      correlation_id: correlationId,
    });
  }

  await setUserPersona(userId, typedPersona);
  await writeAuditLog({
    actorUserId: userId,
    action: "persona_selected",
    status: "ok",
    correlationId,
    metadata: { persona: typedPersona },
  });

  return NextResponse.json({
    persona: typedPersona,
    correlation_id: correlationId,
  });
}
