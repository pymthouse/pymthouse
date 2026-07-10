import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();
import { createOpenMeterClient } from "../src/lib/openmeter/client";
import {
  isKonnectMeteringUrl,
  NETWORK_FEE_USD_NANOS_METER,
  normalizeKonnectMeteringUrl,
  SIGNED_TICKET_COUNT_METER,
} from "../src/lib/openmeter/constants";
import { OPENMETER_METER_DEFINITIONS } from "../src/lib/openmeter/entitlements";
import {
  ensureKonnectTenantCatalog,
  resolveKonnectMeterId,
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
  // Konnect has no /healthz/ready on the metering base; /meters is the catalog we need.
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(`${baseUrl}/meters`, {
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
    await new Promise((r) => setTimeout(r, 2000));
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

  const networkFeeMeterId = await resolveKonnectMeterId(NETWORK_FEE_USD_NANOS_METER);
  const ticketCountMeterId = await resolveKonnectMeterId(SIGNED_TICKET_COUNT_METER);
  console.log(
    `[openmeter-bootstrap] Konnect meter ready: ${NETWORK_FEE_USD_NANOS_METER} id=${networkFeeMeterId}`,
  );
  console.log(
    `[openmeter-bootstrap] Konnect meter ready: ${SIGNED_TICKET_COUNT_METER} id=${ticketCountMeterId}`,
  );
  console.log("[openmeter-bootstrap] Konnect tenant catalog ensured (meters + network_spend feature)");
  console.log(
    "[openmeter-bootstrap] Per-customer trial credits are applied when users are provisioned:",
  );
  console.log("  - Starter plans sync with rate_cards.discounts.usage on Konnect");
  console.log(
    "  - provisionAppUserBilling recreates subscriptions when entitlement-access is missing",
  );
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
    const features = unwrapOpenMeterListResult<{ key: string }>(await client.features.list());
    if (features.some((f) => f.key === featureKey)) {
      console.log(`[openmeter-bootstrap] feature exists: ${featureKey}`);
      return;
    }
    await client.features.create({
      key: featureKey,
      name: "Network spend",
      meterSlug: NETWORK_FEE_USD_NANOS_METER,
    });
    console.log(`[openmeter-bootstrap] created feature: ${featureKey}`);
  } catch (err) {
    console.warn("[openmeter-bootstrap] feature bootstrap skipped:", err);
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
    "[openmeter-bootstrap] Per-customer trial grants are created at user provision time via customers.entitlements.createGrant",
  );
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
    await bootstrapKonnect(baseUrl, apiKey, featureKey);
  } else {
    await bootstrapSelfHosted(baseUrl, apiKey, featureKey);
  }
  console.log("[openmeter-bootstrap] done");
}

main().catch((err) => {
  console.error("[openmeter-bootstrap] failed:", err);
  process.exit(1);
});
