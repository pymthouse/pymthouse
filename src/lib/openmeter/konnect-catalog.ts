import {
  CREATE_SIGNED_TICKET_EVENT_TYPE,
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
  NETWORK_FEE_USD_MICROS_METER,
  SIGNED_TICKET_COUNT_METER,
} from "./constants";
import { konnectAdminFetch } from "./konnect-admin-client";
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
    key: NETWORK_FEE_USD_MICROS_METER,
    name: "Network fee (USD micros)",
    description:
      "Livepeer signed-ticket network fee (USD micros) — sum of signer computed_fee_usd_micros",
    event_type: CREATE_SIGNED_TICKET_EVENT_TYPE,
    aggregation: "sum" as const,
    value_property: "$.network_fee_usd_micros",
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

function catalogFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return konnectAdminFetch<T>(path, init, "catalog");
}

let konnectCatalogEnsured = false;
let konnectMeterIdByKeyCache: Map<string, string> | null = null;

/** Konnect meter query paths require ULIDs; the SDK passes slugs like network_fee_usd_micros. */
export async function resolveKonnectMeterId(meterIdOrSlug: string): Promise<string> {
  if (isOpenMeterUlid(meterIdOrSlug)) {
    return meterIdOrSlug;
  }

  if (!konnectMeterIdByKeyCache) {
    const listed = await catalogFetch<KonnectPage<KonnectMeter>>("/meters");
    konnectMeterIdByKeyCache = new Map(
      (listed.data ?? []).map((meter) => [meter.key, meter.id]),
    );
  }

  const meterId = konnectMeterIdByKeyCache.get(meterIdOrSlug);
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
  if (konnectCatalogEnsured) {
    return;
  }

  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), process.env.OPENMETER_API_KEY)) {
    return;
  }

  const listed = await catalogFetch<KonnectPage<KonnectMeter>>("/meters");
  const existingMeters = listed.data ?? [];

  for (const meter of KONNECT_METER_DEFINITIONS) {
    if (existingMeters.some((item) => item.key === meter.key)) {
      continue;
    }
    await catalogFetch<KonnectMeter>("/meters", {
      method: "POST",
      body: JSON.stringify(meter),
    });
  }

  const refreshed = await catalogFetch<KonnectPage<KonnectMeter>>("/meters");
  const networkFeeMeter = (refreshed.data ?? []).find(
    (meter) => meter.key === NETWORK_FEE_USD_MICROS_METER,
  );
  if (!networkFeeMeter) {
    throw new Error(`Konnect meter missing: ${NETWORK_FEE_USD_MICROS_METER}`);
  }

  const features = await catalogFetch<KonnectPage<KonnectFeature>>("/features");
  const featureKey = trialFeatureKey.trim() || DEFAULT_TRIAL_FEATURE_KEY;
  if (!(features.data ?? []).some((feature) => feature.key === featureKey)) {
    await catalogFetch<KonnectFeature>("/features", {
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
  const features = await catalogFetch<KonnectPage<KonnectFeature>>("/features");
  return (features.data ?? []).find((feature) => feature.key === featureKey)?.id ?? null;
}
