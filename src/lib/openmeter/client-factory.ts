import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appOpenMeterConfig } from "@/db/schema";
import type { OpenMeterBackendMode } from "./constants";
import { NETWORK_FEE_USD_NANOS_METER } from "./constants";
import { createOpenMeterClient, getHostedOpenMeterClient } from "./client";
import type { OpenMeter } from "@openmeter/sdk";

export type ResolvedAppOpenMeterConfig = {
  mode: OpenMeterBackendMode;
  baseUrl: string;
  apiKey?: string;
  meterSlug: string;
  trialFeatureKey: string;
};

/** Map legacy micros meter rows onto the nanos meter used by collector ingest. */
export function resolveNetworkFeeMeterSlug(raw: string | null | undefined): string {
  if (!raw?.trim() || raw.trim() === "network_fee_usd_micros") {
    return NETWORK_FEE_USD_NANOS_METER;
  }
  return raw.trim();
}

function decodeApiKey(stored: string | null | undefined): string | undefined {
  if (!stored?.trim()) {
    return undefined;
  }
  try {
    return Buffer.from(stored, "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}

export function encodeApiKeyForStorage(apiKey: string): string {
  return Buffer.from(apiKey, "utf-8").toString("base64");
}

function isMissingRelationError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "42P01"
  );
}

export async function getAppOpenMeterConfigRow(clientId: string) {
  try {
    const rows = await db
      .select()
      .from(appOpenMeterConfig)
      .where(eq(appOpenMeterConfig.clientId, clientId))
      .limit(1);
    return rows[0] ?? null;
  } catch (err) {
    if (isMissingRelationError(err)) {
      return null;
    }
    throw err;
  }
}

export async function resolveAppOpenMeterConfig(
  clientId: string,
): Promise<ResolvedAppOpenMeterConfig> {
  const row = await getAppOpenMeterConfigRow(clientId);
  const mode = (row?.mode || "pymthouse_hosted") as OpenMeterBackendMode;

  if (mode === "pymthouse_hosted") {
    return {
      mode,
      baseUrl: process.env.OPENMETER_URL?.replace(/\/$/, "") || "http://127.0.0.1:48888",
      apiKey: process.env.OPENMETER_API_KEY?.trim() || undefined,
      meterSlug: resolveNetworkFeeMeterSlug(row?.meterSlug),
      trialFeatureKey: row?.trialFeatureKey || process.env.OPENMETER_TRIAL_FEATURE_KEY || "network_spend",
    };
  }

  if (!row?.baseUrl?.trim()) {
    throw new Error(`BYO OpenMeter missing baseUrl for app ${clientId}`);
  }

  return {
    mode,
    baseUrl: row.baseUrl.replace(/\/$/, ""),
    apiKey: decodeApiKey(row.apiKeyEncrypted),
    meterSlug: resolveNetworkFeeMeterSlug(row.meterSlug),
    trialFeatureKey: row.trialFeatureKey || "network_spend",
  };
}

/** Hosted OpenMeter is always used for platform trial credits. */
export function getHostedTrialOpenMeterClient(): OpenMeter | null {
  return getHostedOpenMeterClient();
}

export async function getOpenMeterClientForApp(clientId: string): Promise<OpenMeter | null> {
  const config = await resolveAppOpenMeterConfig(clientId);
  if (config.mode === "pymthouse_hosted") {
    return getHostedOpenMeterClient();
  }
  return createOpenMeterClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
}

export async function getMeterSlugForApp(clientId: string): Promise<string> {
  const config = await resolveAppOpenMeterConfig(clientId);
  return config.meterSlug;
}

export async function getTrialFeatureKeyForApp(clientId: string): Promise<string> {
  const config = await resolveAppOpenMeterConfig(clientId);
  return config.trialFeatureKey;
}
