import {
  OPENMETER_SLUG_KEY_MAX_LENGTH,
  compactClientSlug,
  toOpenMeterSlugKey,
} from "./slug-keys";

/** Max length for custom plan names (OpenMeter + dashboard). */
export const CUSTOM_PLAN_NAME_MAX_LENGTH = 64;

/**
 * Letters, numbers, spaces, hyphen, underscore, period.
 * Must start and end with a letter or number (single char allowed).
 */
export const CUSTOM_PLAN_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]*[A-Za-z0-9])?$/;

export function validateCustomPlanName(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) {
    return { ok: false, error: "Plan name is required" };
  }
  if (value.length > CUSTOM_PLAN_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Plan name must be at most ${CUSTOM_PLAN_NAME_MAX_LENGTH} characters`,
    };
  }
  if (!CUSTOM_PLAN_NAME_PATTERN.test(value)) {
    return {
      ok: false,
      error:
        "Plan name may only use letters, numbers, spaces, hyphens (-), underscores (_), and periods (.), and must start and end with a letter or number.",
    };
  }
  return { ok: true, value };
}

/** Normalize legacy names for storage when migrating or auto-repairing. */
export function normalizeCustomPlanName(raw: string): string {
  const collapsed = raw
    .trim()
    .replace(/[^A-Za-z0-9 _.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) {
    return "Plan";
  }
  if (collapsed.length <= CUSTOM_PLAN_NAME_MAX_LENGTH && CUSTOM_PLAN_NAME_PATTERN.test(collapsed)) {
    return collapsed;
  }
  const trimmed = collapsed.slice(0, CUSTOM_PLAN_NAME_MAX_LENGTH).trim();
  if (CUSTOM_PLAN_NAME_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const alnum = trimmed.replace(/[^A-Za-z0-9]+/g, "").slice(0, CUSTOM_PLAN_NAME_MAX_LENGTH);
  return alnum || "Plan";
}

/** ASCII-safe display string for OpenMeter plan / rate-card names. */
export function toOpenMeterDisplayName(name: string): string {
  const normalized = normalizeCustomPlanName(name);
  return normalized.slice(0, 128);
}

/** OpenMeter plan.key — lowercase snake_case, max 64 chars. */
export function buildOpenMeterPlanKey(clientId: string, planId: string): string {
  return toOpenMeterSlugKey(compactClientSlug(clientId), "plan", planId);
}

export function buildOpenMeterRateCardKey(input: {
  pipeline: string;
  modelId: string;
}): string {
  const model = input.modelId === "*" ? "all" : input.modelId;
  return toOpenMeterSlugKey("usage", input.pipeline, model);
}

export function openMeterCapabilityLabel(input: {
  pipeline: string;
  modelId: string;
}): string {
  const modelLabel = input.modelId === "*" ? "all models" : input.modelId;
  return `${input.pipeline} - ${modelLabel}`.slice(0, 128);
}
