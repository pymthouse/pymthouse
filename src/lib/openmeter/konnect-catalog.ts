import {
  CREATE_SIGNED_TICKET_EVENT_TYPE,
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
  NETWORK_FEE_USD_MICROS_METER,
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
  meter?: { id?: string; key?: string };
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

/** Allow only fixed catalog paths or /features|meters/{ULID}; return regex match to break taint. */
function sanitizeKonnectAdminPath(path: string): string {
  const match = /^(\/(?:meters|features)(?:\/[0-7][0-9A-HJKMNP-TV-Z]{25})?)$/i.exec(path);
  if (!match) {
    throw new Error(`Refusing Konnect catalog path: ${path}`);
  }
  return match[1];
}

async function konnectAdminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, apiKey } = konnectAdminConfig();
  const safePath = sanitizeKonnectAdminPath(path);
  const response = await fetch(`${baseUrl}${safePath}`, {
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

/** Konnect meter query paths require ULIDs; the SDK passes slugs like network_fee_usd_micros. */
export async function resolveKonnectMeterId(meterIdOrSlug: string): Promise<string> {
  if (isOpenMeterUlid(meterIdOrSlug)) {
    return meterIdOrSlug;
  }

  if (!konnectMeterIdByKeyCache) {
    const listed = await konnectAdminFetch<KonnectPage<KonnectMeter>>("/meters");
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

  const listed = await konnectAdminFetch<KonnectPage<KonnectMeter>>("/meters");
  const existingMeters = listed.data ?? [];

  for (const meter of KONNECT_METER_DEFINITIONS) {
    if (existingMeters.some((item) => item.key === meter.key)) {
      continue;
    }
    await konnectAdminFetch<KonnectMeter>("/meters", {
      method: "POST",
      body: JSON.stringify(meter),
    });
  }

  const refreshed = await konnectAdminFetch<KonnectPage<KonnectMeter>>("/meters");
  const networkFeeMeter = (refreshed.data ?? []).find(
    (meter) => meter.key === NETWORK_FEE_USD_MICROS_METER,
  );
  if (!networkFeeMeter) {
    throw new Error(`Konnect meter missing: ${NETWORK_FEE_USD_MICROS_METER}`);
  }

  const features = await konnectAdminFetch<KonnectPage<KonnectFeature>>("/features");
  const featureKey = trialFeatureKey.trim() || DEFAULT_TRIAL_FEATURE_KEY;
  const existingFeature = (features.data ?? []).find((feature) => feature.key === featureKey);
  const meterMatches =
    existingFeature?.meter?.id === networkFeeMeter.id ||
    existingFeature?.meter?.key === NETWORK_FEE_USD_MICROS_METER;

  if (existingFeature && !meterMatches) {
    const featureIdMatch = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.exec(existingFeature.id);
    if (!featureIdMatch) {
      throw new Error(
        `Konnect feature id is not a valid ULID for key ${featureKey}: ${existingFeature.id}`,
      );
    }
    await konnectAdminFetch(`/features/${featureIdMatch[0]}`, { method: "DELETE" });
    await konnectAdminFetch<KonnectFeature>("/features", {
      method: "POST",
      body: JSON.stringify({
        key: featureKey,
        name: "Network spend",
        meter: { id: networkFeeMeter.id },
      }),
    });
  } else if (!existingFeature) {
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
