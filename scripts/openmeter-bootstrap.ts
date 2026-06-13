import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();
import { createOpenMeterClient } from "../src/lib/openmeter/client";
import {
  isKonnectMeteringUrl,
  normalizeKonnectMeteringUrl,
} from "../src/lib/openmeter/constants";
import { OPENMETER_METER_DEFINITIONS } from "../src/lib/openmeter/entitlements";
import {
  ensureKonnectTenantCatalog,
  unwrapOpenMeterListResult,
} from "../src/lib/openmeter/konnect-catalog";
import { defaultStarterIncludedUsdMicros } from "../src/lib/starter-default-plan-display";

async function waitForHealthy(baseUrl: string, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/debug/metrics`);
      if (resp.ok) {
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`OpenMeter not healthy at ${baseUrl}`);
}

async function waitForKonnectHealthy(
  baseUrl: string,
  apiKey: string,
  attempts = 15,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(`${baseUrl}/healthz/ready`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (resp.ok) {
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Konnect Metering & Billing not ready at ${baseUrl}/healthz/ready`);
}

async function main() {
  const rawBaseUrl = (process.env.OPENMETER_URL || "http://127.0.0.1:48888").replace(/\/$/, "");
  const apiKey = process.env.OPENMETER_API_KEY?.trim() || undefined;
  const baseUrl = isKonnectMeteringUrl(rawBaseUrl, apiKey)
    ? normalizeKonnectMeteringUrl(rawBaseUrl)
    : rawBaseUrl;
  const trialUsdMicros = defaultStarterIncludedUsdMicros();
  const featureKey = process.env.OPENMETER_TRIAL_FEATURE_KEY?.trim() || "network_spend";

  if (!process.env.OPENMETER_URL) {
    console.log("[openmeter-bootstrap] OPENMETER_URL unset; using", baseUrl);
  }
  console.log(
    `[openmeter-bootstrap] default starter trial allowance: ${trialUsdMicros} USD micros ($${(
      Number(trialUsdMicros) / 1_000_000
    ).toFixed(2)}) on feature ${featureKey}`,
  );

  if (isKonnectMeteringUrl(baseUrl, apiKey) && apiKey) {
    await waitForKonnectHealthy(baseUrl, apiKey);
    await ensureKonnectTenantCatalog();
    console.log("[openmeter-bootstrap] Konnect tenant catalog ensured (meters + network_spend feature)");
    console.log(
      "[openmeter-bootstrap] Per-customer trial credits are applied when users are provisioned:",
    );
    console.log(
      "  - Starter plans sync with rate_cards.discounts.usage on Konnect",
    );
    console.log(
      "  - provisionAppUserBilling recreates subscriptions when entitlement-access is missing",
    );
    return;
  }

  await waitForHealthy(baseUrl);
  const client = createOpenMeterClient({
    baseUrl,
    apiKey,
  });

  const existing = unwrapOpenMeterListResult<{ slug: string; groupBy?: Record<string, string> }>(
    await client.meters.list(),
  );

  for (const meter of OPENMETER_METER_DEFINITIONS) {
    const existingMeter = (existing || []).find((m) => m.slug === meter.slug);
    if (existingMeter) {
      const groupBy = existingMeter.groupBy ?? {};
      const hasPipelineGroupBy = "pipeline" in groupBy && "model_id" in groupBy;
      console.log(`[openmeter-bootstrap] meter exists: ${meter.slug}`);
      if (!hasPipelineGroupBy) {
        console.warn(
          `[openmeter-bootstrap] meter ${meter.slug} is missing pipeline/model_id groupBy — recreate OpenMeter or add groupBy manually for per-capability retail pricing`,
        );
      }
      continue;
    }
    await client.meters.create(meter);
    console.log(`[openmeter-bootstrap] created meter: ${meter.slug}`);
  }

  try {
    const features = unwrapOpenMeterListResult<{ key: string }>(await client.features.list());
    const hasFeature = features.some((f) => f.key === featureKey);
    if (hasFeature) {
      console.log(`[openmeter-bootstrap] feature exists: ${featureKey}`);
    } else {
      await client.features.create({
        key: featureKey,
        name: "Network spend",
        meterSlug: "network_fee_usd_micros",
      });
      console.log(`[openmeter-bootstrap] created feature: ${featureKey}`);
    }
  } catch (err) {
    console.warn("[openmeter-bootstrap] feature bootstrap skipped:", err);
  }

  console.log(
    "[openmeter-bootstrap] Per-customer trial grants are created at user provision time via customers.entitlements.createGrant",
  );
  console.log("[openmeter-bootstrap] done");
}

main().catch((err) => {
  console.error("[openmeter-bootstrap] failed:", err);
  process.exit(1);
});
