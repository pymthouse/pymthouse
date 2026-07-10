import type { OpenMeter } from "@openmeter/sdk";
import { billingStableFeatureKeysEnabled } from "@/lib/billing/feature-flags";
import { NETWORK_FEE_USD_NANOS_METER } from "./constants";
import { unwrapOpenMeterListResult } from "./konnect-catalog";
import {
  compactClientSlug,
  isValidOpenMeterSlugKey,
  toOpenMeterSlugKey,
} from "./slug-keys";

export {
  isValidOpenMeterSlugKey,
  OPENMETER_SLUG_KEY_MAX_LENGTH as OPENMETER_FEATURE_KEY_MAX_LENGTH,
  OPENMETER_SLUG_KEY_MAX_LENGTH,
  OPENMETER_SLUG_KEY_PATTERN,
} from "./slug-keys";

/** Stable app-level feature key (preferred for OpenMeter rate cards). */
export function buildAppCapabilityFeatureKey(input: {
  clientId: string;
  pipeline: string;
  modelId: string;
}): string {
  const model = input.modelId === "*" ? "all" : input.modelId;
  return toOpenMeterSlugKey(
    compactClientSlug(input.clientId),
    "product",
    input.pipeline,
    model,
  );
}

/** Plan-scoped feature key (compact snake_case). */
export function buildCapabilityFeatureKey(input: {
  clientId: string;
  planId: string;
  pipeline: string;
  modelId: string;
}): string {
  const model = input.modelId === "*" ? "all" : input.modelId;
  return toOpenMeterSlugKey(
    compactClientSlug(input.clientId),
    "cap",
    input.planId,
    input.pipeline,
    model,
  );
}

export function resolveCapabilityFeatureKey(input: {
  clientId: string;
  planId: string;
  pipeline: string;
  modelId: string;
}): string {
  if (billingStableFeatureKeysEnabled()) {
    return buildAppCapabilityFeatureKey({
      clientId: input.clientId,
      pipeline: input.pipeline,
      modelId: input.modelId,
    });
  }
  return buildCapabilityFeatureKey(input);
}

export function validateCapabilityFeatureKeys(input: {
  clientId: string;
  planId: string;
  capabilities: Array<{ pipeline: string; modelId: string }>;
}): { ok: true } | { ok: false; error: string } {
  for (const cap of input.capabilities) {
    const key = resolveCapabilityFeatureKey({
      clientId: input.clientId,
      planId: input.planId,
      pipeline: cap.pipeline,
      modelId: cap.modelId,
    });
    if (!isValidOpenMeterSlugKey(key)) {
      return {
        ok: false,
        error: `OpenMeter feature key for ${cap.pipeline} / ${cap.modelId} is invalid. Use shorter pipeline/model identifiers.`,
      };
    }
  }
  return { ok: true };
}

export function buildCapabilityMeterGroupByFilters(input: {
  pipeline: string;
  modelId: string;
}): Record<string, { $eq: string }> {
  const filters: Record<string, { $eq: string }> = {
    pipeline: { $eq: input.pipeline },
  };
  if (input.modelId !== "*") {
    filters.model_id = { $eq: input.modelId };
  }
  return filters;
}

export async function ensureCapabilityOpenMeterFeature(input: {
  client: OpenMeter;
  clientId: string;
  planId: string;
  pipeline: string;
  modelId: string;
  displayName: string;
  /** When set (e.g. from plan_capability_bundles.openmeter_feature_key), use if valid. */
  preferredKey?: string | null;
}): Promise<string> {
  const storedKey =
    input.preferredKey && isValidOpenMeterSlugKey(input.preferredKey)
      ? input.preferredKey
      : null;
  const key = storedKey ?? resolveCapabilityFeatureKey(input);

  if (!isValidOpenMeterSlugKey(key)) {
    throw new Error(
      `OpenMeter feature key is invalid (${key}) for ${input.pipeline} / ${input.modelId}`,
    );
  }

  try {
    const existing = unwrapOpenMeterListResult<{ key: string }>(
      await input.client.features.list(),
    );
    if (existing.some((f) => f.key === key)) {
      return key;
    }
  } catch {
    /* create below */
  }

  await input.client.features.create({
    key,
    name: input.displayName,
    meterSlug: NETWORK_FEE_USD_NANOS_METER,
    advancedMeterGroupByFilters: buildCapabilityMeterGroupByFilters({
      pipeline: input.pipeline,
      modelId: input.modelId,
    }),
  });

  return key;
}
