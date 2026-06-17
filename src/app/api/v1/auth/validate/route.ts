import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { apiKeys, planCapabilityBundles, plans } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { resolveApiKeyOpenMeterSubscription } from "@/lib/openmeter/api-key-subscription";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { buildValidateResponseBody } from "@/lib/bpp/validate-response";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const keyHash = hashToken(token);
  const apiKeyRows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  const apiKey = apiKeyRows[0];
  if (!apiKey || apiKey.status !== "active") {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  if (!apiKey.subscriptionId && !apiKey.openmeterSubscriptionId) {
    return NextResponse.json(
      buildValidateResponseBody({
        clientId: apiKey.clientId,
        plan: null,
        allowedModels: [],
      }),
    );
  }

  if (requireOpenMeterForUsageReads() && isHostedAdminClientAvailable()) {
    const resolved = await resolveApiKeyOpenMeterSubscription({
      apiKey,
      client: getHostedAdminClient(),
    });
    if (!resolved) {
      return NextResponse.json({ valid: false }, { status: 401 });
    }

    if (!resolved.planId) {
      return NextResponse.json(
        buildValidateResponseBody({
          clientId: apiKey.clientId,
          plan: null,
          allowedModels: [],
          openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        }),
      );
    }

    const planRows = await db
      .select()
      .from(plans)
      .where(eq(plans.id, resolved.planId))
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      return NextResponse.json({ valid: false }, { status: 401 });
    }

    const capabilities = await db
      .select()
      .from(planCapabilityBundles)
      .where(eq(planCapabilityBundles.planId, plan.id));

    return NextResponse.json(
      buildValidateResponseBody({
        clientId: apiKey.clientId,
        openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        plan: {
          ...plan,
          includedUnits: plan.includedUnits != null ? plan.includedUnits.toString() : null,
          overageRateUsd: plan.overageRateUsd ?? null,
        },
        allowedModels: capabilities.map((bundle) => bundle.modelId).filter(Boolean),
      }),
    );
  }

  // Hard cutover: subscription-backed API keys require OpenMeter to validate.
  // When OPENMETER_URL / the hosted admin client is unavailable (the branch above
  // is skipped), there is intentionally no Postgres-only fallback — reject the
  // key rather than honoring a legacy local subscription row.
  return NextResponse.json({ valid: false }, { status: 401 });
}
