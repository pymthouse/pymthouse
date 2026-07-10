import {
  CREATE_SIGNED_TICKET_EVENT_TYPE,
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
  NETWORK_FEE_USD_NANOS_METER,
  normalizeKonnectMeteringUrl,
  SIGNED_TICKET_COUNT_METER,
} from "./constants";
import { isOpenMeterUlid } from "./konnect-routes";
import { shouldUseKonnectRoutes } from "./route-mode";

type KonnectPage<T> = {
  data?: T[];
};

type KonnectMeter = {
  id: string;
  key: string;
};

type KonnectFeature = {
  id: string;
  key: string;
};

const KONNECT_METER_DEFINITIONS = [
  {
    key: NETWORK_FEE_USD_NANOS_METER,
    name: "Network fee (USD nanos)",
    description:
      "Livepeer signed-ticket network fee (USD nanos; 1 USD = 1e9) — sum of collector network_fee_usd_nanos",
    event_type: CREATE_SIGNED_TICKET_EVENT_TYPE,
    aggregation: "sum" as const,
    value_property: "$.network_fee_usd_nanos",
    dimensions: {
      client_id: "$.client_id",
      external_user_id: "$.external_user_id",
      pipeline: "$.pipeline",
      model_id: "$.model_id",
    },
  },
  {
    key: SIGNED_TICKET_COUNT_METER,
    name: "Signed ticket count",
    description: "Signed ticket count per user",
    event_type: CREATE_SIGNED_TICKET_EVENT_TYPE,
    aggregation: "count" as const,
    dimensions: {
      client_id: "$.client_id",
      external_user_id: "$.external_user_id",
      pipeline: "$.pipeline",
      model_id: "$.model_id",
    },
  },
];

/** SDK list helpers sometimes return Konnect page envelopes instead of arrays. */
export function unwrapOpenMeterListResult<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return record.items as T[];
    }
    if (Array.isArray(record.data)) {
      return record.data as T[];
    }
  }
  return [];
}

function konnectAdminConfig(): { baseUrl: string; apiKey: string } {
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENMETER_API_KEY is required for Konnect catalog provisioning");
  }
  return {
    baseUrl: normalizeKonnectMeteringUrl(getHostedOpenMeterUrl()),
    apiKey,
  };
}

async function konnectAdminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, apiKey } = konnectAdminConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Konnect catalog API ${init?.method ?? "GET"} ${path} failed (${response.status}): ${body}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

let konnectCatalogEnsured = false;
let konnectMeterIdByKeyCache: Map<string, string> | null = null;

function cacheKonnectMeters(meters: KonnectMeter[]): void {
  konnectMeterIdByKeyCache = new Map(meters.map((meter) => [meter.key, meter.id]));
}

async function listKonnectMeters(): Promise<KonnectMeter[]> {
  const listed = await konnectAdminFetch<KonnectPage<KonnectMeter>>("/meters");
  return listed.data ?? [];
}

/** Konnect meter query paths require ULIDs; the SDK passes slugs like network_fee_usd_nanos. */
export async function resolveKonnectMeterId(meterIdOrSlug: string): Promise<string> {
  if (isOpenMeterUlid(meterIdOrSlug)) {
    return meterIdOrSlug;
  }

  await ensureKonnectTenantCatalog();

  let meterId = konnectMeterIdByKeyCache?.get(meterIdOrSlug);
  if (!meterId) {
    cacheKonnectMeters(await listKonnectMeters());
    meterId = konnectMeterIdByKeyCache?.get(meterIdOrSlug);
  }
  if (!meterId) {
    throw new Error(`Konnect meter not found for key: ${meterIdOrSlug}`);
  }
  return meterId;
}

/**
 * Idempotent Konnect tenant catalog bootstrap (meters + network_spend feature).
 * Mirrors auth0-livepeer/scripts/lib/konnect-metering.ts for runtime self-heal.
 */
export async function ensureKonnectTenantCatalog(
  trialFeatureKey: string = DEFAULT_TRIAL_FEATURE_KEY,
): Promise<void> {
  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), process.env.OPENMETER_API_KEY)) {
    return;
  }

  if (
    konnectCatalogEnsured &&
    konnectMeterIdByKeyCache?.has(NETWORK_FEE_USD_NANOS_METER) &&
    konnectMeterIdByKeyCache.has(SIGNED_TICKET_COUNT_METER)
  ) {
    return;
  }

  let existingMeters = await listKonnectMeters();

  for (const meter of KONNECT_METER_DEFINITIONS) {
    if (existingMeters.some((item) => item.key === meter.key)) {
      continue;
    }
    await konnectAdminFetch<KonnectMeter>("/meters", {
      method: "POST",
      body: JSON.stringify(meter),
    });
  }

  existingMeters = await listKonnectMeters();
  cacheKonnectMeters(existingMeters);

  const networkFeeMeter = existingMeters.find(
    (meter) => meter.key === NETWORK_FEE_USD_NANOS_METER,
  );
  if (!networkFeeMeter) {
    throw new Error(`Konnect meter missing: ${NETWORK_FEE_USD_NANOS_METER}`);
  }

  const features = await konnectAdminFetch<KonnectPage<KonnectFeature>>("/features");
  const featureKey = trialFeatureKey.trim() || DEFAULT_TRIAL_FEATURE_KEY;
  if (!(features.data ?? []).some((feature) => feature.key === featureKey)) {
    await konnectAdminFetch<KonnectFeature>("/features", {
      method: "POST",
      body: JSON.stringify({
        key: featureKey,
        name: "Network spend",
        meter: { id: networkFeeMeter.id },
      }),
    });
  }

  konnectCatalogEnsured = true;
}

export function resetKonnectCatalogEnsuredForTests(): void {
  konnectCatalogEnsured = false;
  konnectMeterIdByKeyCache = null;
}

export async function findKonnectFeatureIdByKey(featureKey: string): Promise<string | null> {
  const features = await konnectAdminFetch<KonnectPage<KonnectFeature>>("/features");
  return (features.data ?? []).find((feature) => feature.key === featureKey)?.id ?? null;
}
