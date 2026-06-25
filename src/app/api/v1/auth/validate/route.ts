import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { apiKeys, planCapabilityBundles, plans, signerConfig } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { resolveApiKeyOpenMeterSubscription } from "@/lib/openmeter/api-key-subscription";
import { resolveValidateAdminClient } from "@/lib/openmeter/validate-admin-client";
import { buildValidateResponseBody } from "@/lib/bpp/validate-response";
import {
  buildC0ValidateResponseBody,
  toCapabilityIds,
  CAPABILITY_WILDCARD,
  type BillingMode,
} from "@/lib/bpp/validate-response-c0";
import { bppValidateV2Enabled } from "@/lib/billing/feature-flags";
import { C0ValidateRequestBodySchema } from "@/lib/openapi/schemas/misc";

/** Stable provider slug for the pymthouse reference billing provider. */
const PROVIDER_SLUG = "pymthouse";

type ApiKeyRow = typeof apiKeys.$inferSelect;
type PlanRow = typeof plans.$inferSelect;
type BundleRow = typeof planCapabilityBundles.$inferSelect;

/**
 * Outcome of resolving an API key for the `validate` endpoints, shared by the
 * legacy `GET` and the C0 `POST` so the DB/OpenMeter resolution flow lives in
 * exactly one place. Each handler maps these variants onto its own response
 * shape (legacy vs C0) — see the `GET`/`POST` switch statements below.
 *
 *  - `invalid`         → key unknown/inactive, or a subscription-backed key that
 *                        cannot be resolved against OpenMeter (hard cutover: no
 *                        Postgres-only fallback). Handlers return 401.
 *  - `no_subscription` → active key with no subscription (delegated MVP).
 *  - `no_plan`         → subscription resolved but no local plan row.
 *  - `with_plan`       → subscription resolved to a concrete plan + capabilities.
 */
type ResolvedKey =
  | { kind: "invalid" }
  | { kind: "no_subscription"; apiKey: ApiKeyRow }
  | { kind: "no_plan"; apiKey: ApiKeyRow; openmeterSubscriptionId: string | null }
  | {
      kind: "with_plan";
      apiKey: ApiKeyRow;
      plan: PlanRow;
      bundles: BundleRow[];
      openmeterSubscriptionId: string | null;
    };

/**
 * Resolve an API key (by token hash) through the shared validate flow: look up
 * the key, then — for subscription-backed keys — resolve the OpenMeter
 * subscription and its plan/capability bundles.
 *
 * The OpenMeter admin client is obtained via `resolveValidateAdminClient()` so
 * both `GET` and `POST` honor the same test-injection seam and the same hard
 * cutover (subscription-backed keys require OpenMeter; otherwise `invalid`).
 */
async function resolveKeyValidation(keyHash: string): Promise<ResolvedKey> {
  const apiKeyRows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  const apiKey = apiKeyRows[0];
  if (!apiKey || apiKey.status !== "active") {
    return { kind: "invalid" };
  }

  if (!apiKey.subscriptionId && !apiKey.openmeterSubscriptionId) {
    return { kind: "no_subscription", apiKey };
  }

  // Subscription-backed keys require OpenMeter. When the hosted admin client is
  // unavailable (the test seam returns null / OpenMeter reads disabled), there is
  // intentionally no Postgres-only fallback — reject rather than honor a legacy
  // local subscription row.
  const adminClient = resolveValidateAdminClient();
  if (!adminClient) {
    return { kind: "invalid" };
  }

  const resolved = await resolveApiKeyOpenMeterSubscription({
    apiKey,
    client: adminClient,
  });
  if (!resolved) {
    return { kind: "invalid" };
  }

  if (!resolved.planId) {
    return {
      kind: "no_plan",
      apiKey,
      openmeterSubscriptionId: resolved.openmeterSubscriptionId,
    };
  }

  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, resolved.planId))
    .limit(1);
  const plan = planRows[0];
  if (!plan) {
    return { kind: "invalid" };
  }

  const bundles = await db
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.planId, plan.id));

  return {
    kind: "with_plan",
    apiKey,
    plan,
    bundles,
    openmeterSubscriptionId: resolved.openmeterSubscriptionId,
  };
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const resolved = await resolveKeyValidation(hashToken(token));

  switch (resolved.kind) {
    case "invalid":
      return NextResponse.json({ valid: false }, { status: 401 });
    case "no_subscription":
      return NextResponse.json(
        buildValidateResponseBody({
          clientId: resolved.apiKey.clientId,
          plan: null,
          allowedModels: [],
        }),
      );
    case "no_plan":
      return NextResponse.json(
        buildValidateResponseBody({
          clientId: resolved.apiKey.clientId,
          plan: null,
          allowedModels: [],
          openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        }),
      );
    case "with_plan":
      return NextResponse.json(
        buildValidateResponseBody({
          clientId: resolved.apiKey.clientId,
          openmeterSubscriptionId: resolved.openmeterSubscriptionId,
          plan: {
            ...resolved.plan,
            includedUnits:
              resolved.plan.includedUnits != null
                ? resolved.plan.includedUnits.toString()
                : null,
            overageRateUsd: resolved.plan.overageRateUsd ?? null,
          },
          allowedModels: resolved.bundles.map((bundle) => bundle.modelId).filter(Boolean),
        }),
      );
  }
}

// ---------------------------------------------------------------------------
// PYMT-3 — additive, C0-conformant `validate` (POST {key})
//
// The legacy `GET` above is intentionally left untouched (deprecated, not
// removed) for current consumers. `POST /api/v1/auth/validate` is the NEW
// provider-neutral front door that conforms to the C0 `validate.schema.json`:
//   { valid, user.sub, billing_account, capabilities[pipeline:model], quota,
//     subscriptionRef?, signerSession? }
//
// It is gated behind `BPP_VALIDATE_V2` (default OFF). Flag-off → 404, so the
// endpoint behaves as if absent and the legacy GET path is the only behavior
// in production until the NaaP front door (NAAP-C) is ready (gated by D0).
//
// Both handlers share `resolveKeyValidation()` for DB/OpenMeter resolution and
// differ only in how they map the result onto their response shape.
// ---------------------------------------------------------------------------

/** Neutral, stable subject id for a resolved API key (never a metering id). */
function resolveSubject(apiKey: ApiKeyRow): string {
  return apiKey.appUserId || apiKey.userId || `app:${apiKey.clientId}`;
}

/** Resolve the singleton signer's billing posture (delegated by default). */
async function resolveBillingMode(): Promise<BillingMode> {
  const rows = await db.select({ billingMode: signerConfig.billingMode }).from(signerConfig).limit(1);
  return rows[0]?.billingMode === "prepay" ? "prepay" : "delegated";
}

/** Read `{ key }` from a JSON body without throwing on malformed input. */
async function readKeyFromBody(request: NextRequest): Promise<string | null> {
  try {
    const body = await request.json();
    const parsed = C0ValidateRequestBodySchema.safeParse(body);
    if (parsed.success) {
      return parsed.data.key;
    }
  } catch {
    // Malformed/empty body → treated as a missing key below.
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!bppValidateV2Enabled()) {
    // Endpoint not enabled — behave as if it does not exist (zero regression).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const key = await readKeyFromBody(request);
  if (!key) {
    return NextResponse.json({ valid: false }, { status: 400 });
  }

  const resolved = await resolveKeyValidation(hashToken(key));
  if (resolved.kind === "invalid") {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const billingMode = await resolveBillingMode();
  const billingAccount = {
    // Account of record = the developer app (per PR #149 coordination header:
    // D2/PYMT-1 dropped — no separate billing-account entity). Neutral, app-facing.
    id: resolved.apiKey.clientId,
    providerSlug: PROVIDER_SLUG,
    billingMode,
  };

  switch (resolved.kind) {
    // No subscription, or a subscription without a local plan → delegated MVP:
    // capabilities = all, quota = null.
    case "no_subscription":
      return NextResponse.json(
        buildC0ValidateResponseBody({
          sub: resolveSubject(resolved.apiKey),
          billingAccount,
          capabilities: [CAPABILITY_WILDCARD],
          quota: null,
        }),
      );
    case "no_plan":
      return NextResponse.json(
        buildC0ValidateResponseBody({
          sub: resolveSubject(resolved.apiKey),
          billingAccount,
          capabilities: [CAPABILITY_WILDCARD],
          quota: null,
          openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        }),
      );
    case "with_plan":
      return NextResponse.json(
        buildC0ValidateResponseBody({
          sub: resolveSubject(resolved.apiKey),
          billingAccount,
          capabilities: toCapabilityIds(resolved.bundles),
          quota: null,
          openmeterSubscriptionId: resolved.openmeterSubscriptionId,
        }),
      );
  }
}
