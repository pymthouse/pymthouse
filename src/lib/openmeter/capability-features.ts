import type { OpenMeter } from "@openmeter/sdk";
import { billingStableFeatureKeysEnabled } from "@/lib/billing/feature-flags";
import { NETWORK_FEE_USD_MICROS_METER } from "./constants";
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

/**
 * CloudEvent `data.app` value for a plan capability row.
 *
 * Plan rows store the discovery split `{ pipeline, modelId }`. Ingest writes the
 * wire capability on `data.app` (e.g. `livepeer-example/hello-world`, or the bare
 * token when pipeline === modelId). Meter filters must match that string.
 */
export function capabilityWireAppAttribution(input: {
  pipeline: string;
  modelId: string;
}): string {
  const pipeline = input.pipeline.trim();
  const modelId = input.modelId.trim();
  if (!pipeline || !modelId || modelId === "*") {
    return modelId;
  }
  if (pipeline === modelId) {
    return modelId;
  }
  return `${pipeline}/${modelId}`;
}

export function buildCapabilityMeterGroupByFilters(input: {
  pipeline: string;
  modelId: string;
}): Record<string, { $eq: string }> {
  const filters: Record<string, { $eq: string }> = {
    pipeline: { $eq: input.pipeline },
  };
  if (input.modelId !== "*") {
    filters.app = { $eq: capabilityWireAppAttribution(input) };
  }
  return filters;
}

type OpenMeterFeatureRow = {
  id?: string;
  key: string;
  advancedMeterGroupByFilters?: Record<string, unknown> | null;
};

function meterFilterEq(value: unknown): string {
  if (!value || typeof value !== "object" || !("$eq" in value)) {
    return "";
  }
  const eq = (value as { $eq?: unknown }).$eq;
  return typeof eq === "string" ? eq : "";
}

function capabilityMeterFiltersMatch(
  existing: OpenMeterFeatureRow["advancedMeterGroupByFilters"],
  expected: Record<string, { $eq: string }>,
): boolean {
  if (!existing) {
    return false;
  }
  const expectedKeys = Object.keys(expected);
  const existingKeys = Object.keys(existing);
  if (expectedKeys.length !== existingKeys.length) {
    return false;
  }
  for (const key of expectedKeys) {
    if (expected[key]?.$eq !== meterFilterEq(existing[key])) {
      return false;
    }
  }
  return true;
}

async function loadCapabilityFeatureDetail(
  client: OpenMeter,
  row: OpenMeterFeatureRow,
): Promise<OpenMeterFeatureRow> {
  if (!row.id) {
    return row;
  }
  try {
    const fetched = await client.features.get(row.id);
    if (fetched?.key) {
      return fetched as OpenMeterFeatureRow;
    }
  } catch {
    /* use list row */
  }
  return row;
}

/** @returns true when the stale feature was deleted and must be recreated. */
async function replaceStaleCapabilityFeature(input: {
  client: OpenMeter;
  row: OpenMeterFeatureRow;
  filters: Record<string, { $eq: string }>;
  key: string;
}): Promise<boolean> {
  const detail = await loadCapabilityFeatureDetail(input.client, input.row);
  if (
    capabilityMeterFiltersMatch(detail.advancedMeterGroupByFilters, input.filters) ||
    detail.advancedMeterGroupByFilters == null
  ) {
    return false;
  }
  if (!input.row.id) {
    throw new Error(
      `OpenMeter feature ${input.key} has stale meter filters and cannot be replaced (missing id)`,
    );
  }
  await input.client.features.delete(input.row.id);
  return true;
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

  const filters = buildCapabilityMeterGroupByFilters({
    pipeline: input.pipeline,
    modelId: input.modelId,
  });

  let existingMatch: OpenMeterFeatureRow | undefined;
  try {
    const existing = unwrapOpenMeterListResult<OpenMeterFeatureRow>(
      await input.client.features.list(),
    );
    existingMatch = existing.find((f) => f.key === key);
  } catch {
    existingMatch = undefined;
  }

  if (existingMatch) {
    const replaced = await replaceStaleCapabilityFeature({
      client: input.client,
      row: existingMatch,
      filters,
      key,
    });
    if (!replaced) {
      return key;
    }
  }

  await input.client.features.create({
    key,
    name: input.displayName,
    meterSlug: NETWORK_FEE_USD_MICROS_METER,
    advancedMeterGroupByFilters: filters,
  });

  return key;
}
