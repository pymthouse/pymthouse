import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();
import { createOpenMeterClient } from "../src/lib/openmeter/client";
import {
  isKonnectMeteringUrl,
  NETWORK_FEE_USD_MICROS_METER,
  normalizeKonnectMeteringUrl,
  SIGNED_TICKET_COUNT_METER,
} from "../src/lib/openmeter/constants";
import { OPENMETER_METER_DEFINITIONS } from "../src/lib/openmeter/entitlements";
import {
  ensureKonnectTenantCatalog,
  resolveKonnectMeterId,
  unwrapOpenMeterListResult,
} from "../src/lib/openmeter/konnect-catalog";
import { resolveKonnectStripeAppId } from "../src/lib/openmeter/konnect-billing-profiles";
import { defaultStarterIncludedUsdMicros } from "../src/lib/starter-default-plan-display";

const DEFAULT_LOCAL_OPENMETER_URL = "http://127.0.0.1:48888";
const PROBE_TIMEOUT_MS = 3_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}

async function waitForHealthy(baseUrl: string, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetchWithTimeout(`${baseUrl}/api/v1/debug/metrics`);
      if (resp.ok) {
        return;
      }
      console.warn(
        `[openmeter-bootstrap] OpenMeter not ready (${resp.status}); retry ${i + 1}/${attempts}`,
      );
    } catch (err) {
      console.warn(
        `[openmeter-bootstrap] OpenMeter probe failed; retry ${i + 1}/${attempts}: ${err}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `OpenMeter not healthy at ${baseUrl} after ${attempts} attempts. ` +
      `Start local OpenMeter or set OPENMETER_URL (and OPENMETER_API_KEY for Konnect).`,
  );
}

async function waitForKonnectHealthy(
  baseUrl: string,
  apiKey: string,
  attempts = 10,
): Promise<void> {
  // Konnect has no /healthz/ready on the metering base; /meters is the catalog we need.
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetchWithTimeout(`${baseUrl}/meters`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (resp.ok) {
        return;
      }
      console.warn(
        `[openmeter-bootstrap] Konnect /meters not ready (${resp.status}); retry ${i + 1}/${attempts}`,
      );
    } catch (err) {
      console.warn(
        `[openmeter-bootstrap] Konnect /meters probe failed; retry ${i + 1}/${attempts}: ${err}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Konnect Metering & Billing not ready at ${baseUrl}/meters`);
}

async function bootstrapKonnect(baseUrl: string, apiKey: string, featureKey: string): Promise<void> {
  await waitForKonnectHealthy(baseUrl, apiKey);
  console.log("[openmeter-bootstrap] ensuring Konnect meters:");
  for (const meter of OPENMETER_METER_DEFINITIONS) {
    console.log(`  - ${meter.slug} (${meter.aggregation} ${meter.valueProperty ?? "count"})`);
  }

  await ensureKonnectTenantCatalog(featureKey);

  const networkFeeMeterId = await resolveKonnectMeterId(NETWORK_FEE_USD_MICROS_METER);
  const ticketCountMeterId = await resolveKonnectMeterId(SIGNED_TICKET_COUNT_METER);
  console.log(
    `[openmeter-bootstrap] Konnect meter ready: ${NETWORK_FEE_USD_MICROS_METER} id=${networkFeeMeterId}`,
  );
  console.log(
    `[openmeter-bootstrap] Konnect meter ready: ${SIGNED_TICKET_COUNT_METER} id=${ticketCountMeterId}`,
  );
  console.log("[openmeter-bootstrap] Konnect tenant catalog ensured (meters + network_spend feature)");
  console.log(
    "[openmeter-bootstrap] Discount-then-credit settlement model:",
  );
  console.log(
    "  - Each app end-user is a distinct OpenMeter customer (client_id:external_user_id)",
  );
  console.log(
    "  - Starter plans sync with settlement_mode=credit_then_invoice and discounts.usage = included micros",
  );
  console.log(
    "  - Included starter allowance is plan discounts.usage (OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS); no auto credit grants",
  );
  console.log(
    "  - Mint gate: remaining discount + prepaid credits (manual top-ups / overage)",
  );
  console.log(
    "  - network_spend feature must stay meter-backed (no unit_cost / LLM pricing)",
  );
  try {
    await resolveKonnectStripeAppId();
    console.log("[openmeter-bootstrap] Konnect Stripe app is ready");
  } catch {
    console.warn(
      "[openmeter-bootstrap] Konnect Stripe app not ready — install Stripe in Konnect → Metering & Billing → Settings → Stripe",
    );
  }
}

async function ensureSelfHostedMeters(
  client: ReturnType<typeof createOpenMeterClient>,
): Promise<void> {
  const existing = unwrapOpenMeterListResult<{ slug: string; groupBy?: Record<string, string> }>(
    await client.meters.list(),
  );

  for (const meter of OPENMETER_METER_DEFINITIONS) {
    const existingMeter = existing.find((m) => m.slug === meter.slug);
    if (!existingMeter) {
      await client.meters.create(meter);
      console.log(`[openmeter-bootstrap] created meter: ${meter.slug}`);
      continue;
    }

    const groupBy = existingMeter.groupBy ?? {};
    console.log(`[openmeter-bootstrap] meter exists: ${meter.slug}`);
    if (!("pipeline" in groupBy && "model_id" in groupBy)) {
      console.warn(
        `[openmeter-bootstrap] meter ${meter.slug} is missing pipeline/model_id groupBy — recreate OpenMeter or add groupBy manually for per-capability retail pricing`,
      );
    }
  }
}

async function ensureSelfHostedFeature(
  client: ReturnType<typeof createOpenMeterClient>,
  featureKey: string,
): Promise<void> {
  try {
    const features = unwrapOpenMeterListResult<{
      id: string;
      key: string;
      meterSlug?: string;
    }>(await client.features.list());
    const existing = features.find((f) => f.key === featureKey);
    if (existing?.meterSlug === NETWORK_FEE_USD_MICROS_METER) {
      console.log(`[openmeter-bootstrap] feature exists: ${featureKey}`);
      return;
    }
    if (existing) {
      console.warn(
        `[openmeter-bootstrap] feature ${featureKey} meterSlug=${existing.meterSlug ?? "(none)"} ` +
          `≠ ${NETWORK_FEE_USD_MICROS_METER}; recreating`,
      );
      await client.features.delete(existing.id);
    }
    await client.features.create({
      key: featureKey,
      name: "Network spend",
      meterSlug: NETWORK_FEE_USD_MICROS_METER,
    });
    console.log(
      existing
        ? `[openmeter-bootstrap] recreated feature: ${featureKey}`
        : `[openmeter-bootstrap] created feature: ${featureKey}`,
    );
  } catch (err) {
    console.warn("[openmeter-bootstrap] feature bootstrap skipped:", err);
  }
}

async function probeStripeOAuth(
  baseUrl: string,
  apiKey: string | undefined,
  appsBaseUrl: string,
): Promise<void> {
  try {
    const installResp = await fetchWithTimeout(
      `${baseUrl}/api/v1/marketplace/listings/stripe/install/oauth2`,
      {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      },
    );
    if (installResp.status === 501) {
      console.warn(
        "[openmeter-bootstrap] Stripe Connect unavailable (501). Set apps.baseURL on OpenMeter " +
          `(OPENMETER_APPS_BASE_URL=${appsBaseUrl}) and redeploy.`,
      );
      return;
    }
    if (!installResp.ok) {
      console.warn(
        `[openmeter-bootstrap] Stripe install probe returned ${installResp.status} (apps.baseURL should be ${appsBaseUrl})`,
      );
      return;
    }
    console.log("[openmeter-bootstrap] Stripe marketplace OAuth is available");
  } catch (err) {
    console.warn("[openmeter-bootstrap] Stripe install probe skipped:", err);
  }
}

async function bootstrapSelfHosted(
  baseUrl: string,
  apiKey: string | undefined,
  featureKey: string,
): Promise<void> {
  await waitForHealthy(baseUrl);
  const client = createOpenMeterClient({ baseUrl, apiKey });
  await ensureSelfHostedMeters(client);
  await ensureSelfHostedFeature(client, featureKey);
  console.log(
    "[openmeter-bootstrap] Per-customer trial grants are created at user provision time via customers.entitlements.createGrant (self-hosted)",
  );
  const appsBaseUrl = process.env.OPENMETER_APPS_BASE_URL?.trim() || baseUrl;
  await probeStripeOAuth(baseUrl, apiKey, appsBaseUrl);
}

function requireBootstrapTarget(): { rawBaseUrl: string; apiKey: string | undefined } {
  const rawBaseUrl = process.env.OPENMETER_URL?.trim().replace(/\/$/, "");
  const apiKey = process.env.OPENMETER_API_KEY?.trim() || undefined;
  const allowLocal = process.env.OPENMETER_ALLOW_LOCAL === "1";

  if (!rawBaseUrl) {
    if (allowLocal) {
      return { rawBaseUrl: DEFAULT_LOCAL_OPENMETER_URL, apiKey };
    }
    throw new Error(
      "OPENMETER_URL is required.\n" +
        "  Konnect:  export OPENMETER_URL=https://us.api.konghq.com/v3/openmeter\n" +
        "            export OPENMETER_API_KEY=<kpat_… or spat_…>\n" +
        "  Local:    export OPENMETER_ALLOW_LOCAL=1  (uses http://127.0.0.1:48888)",
    );
  }

  if (isKonnectMeteringUrl(rawBaseUrl, apiKey) && !apiKey) {
    throw new Error(
      "OPENMETER_API_KEY is required for Konnect Metering & Billing " +
        `(${normalizeKonnectMeteringUrl(rawBaseUrl)}).`,
    );
  }

  return { rawBaseUrl, apiKey };
}

async function main() {
  const { rawBaseUrl, apiKey } = requireBootstrapTarget();
  const baseUrl = isKonnectMeteringUrl(rawBaseUrl, apiKey)
    ? normalizeKonnectMeteringUrl(rawBaseUrl)
    : rawBaseUrl;
  const trialUsdMicros = defaultStarterIncludedUsdMicros();
  const featureKey = process.env.OPENMETER_TRIAL_FEATURE_KEY?.trim() || "network_spend";

  console.log(`[openmeter-bootstrap] target: ${baseUrl}`);
  console.log(
    `[openmeter-bootstrap] default starter trial allowance: ${trialUsdMicros} USD micros ($${(
      Number(trialUsdMicros) / 1_000_000
    ).toFixed(2)}) on feature ${featureKey}`,
  );

  if (isKonnectMeteringUrl(baseUrl, apiKey) && apiKey) {
    await bootstrapKonnect(baseUrl, apiKey, featureKey);
  } else {
    await bootstrapSelfHosted(baseUrl, apiKey, featureKey);
  }
  console.log("[openmeter-bootstrap] done");
}

main().catch((err) => {
  console.error("[openmeter-bootstrap] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
