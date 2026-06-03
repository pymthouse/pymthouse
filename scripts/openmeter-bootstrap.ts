import "dotenv/config";
import { createOpenMeterClient } from "../src/lib/openmeter/client";
import { OPENMETER_METER_DEFINITIONS } from "../src/lib/openmeter/entitlements";

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

async function main() {
  const baseUrl = (process.env.OPENMETER_URL || "http://127.0.0.1:48888").replace(/\/$/, "");
  if (!process.env.OPENMETER_URL) {
    console.log("[openmeter-bootstrap] OPENMETER_URL unset; using", baseUrl);
  }

  await waitForHealthy(baseUrl);
  const client = createOpenMeterClient({
    baseUrl,
    apiKey: process.env.OPENMETER_API_KEY?.trim() || undefined,
  });

  const existing = await client.meters.list();

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

  const featureKey = process.env.OPENMETER_TRIAL_FEATURE_KEY?.trim() || "network_spend";
  try {
    const features = await client.features.list();
    const hasFeature = (features || []).some((f) => f.key === featureKey);
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

  const appsBaseUrl = process.env.OPENMETER_APPS_BASE_URL?.trim() || baseUrl;
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  try {
    const installResp = await fetch(
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
    } else if (!installResp.ok) {
      console.warn(
        `[openmeter-bootstrap] Stripe install probe returned ${installResp.status} (apps.baseURL should be ${appsBaseUrl})`,
      );
    } else {
      console.log("[openmeter-bootstrap] Stripe marketplace OAuth is available");
    }
  } catch (err) {
    console.warn("[openmeter-bootstrap] Stripe install probe skipped:", err);
  }

  console.log("[openmeter-bootstrap] done");
}

main().catch((err) => {
  console.error("[openmeter-bootstrap] failed:", err);
  process.exit(1);
});
