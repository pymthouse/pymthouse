/**
 * Live Runner `app` on create_signed_ticket events is the capability name
 * (e.g. `live-video-to-video/scope`). `model_id` is optional and often empty.
 */

export function isUnknownUsageCapability(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim() ?? "";
  return !trimmed || trimmed.toLowerCase() === "unknown";
}

/** Prefer event `app` when `model_id` is missing or unknown. */
export function capabilityFromUsageFields(input: {
  app?: string | null;
  modelId?: string | null;
}): string {
  const app = input.app?.trim() ?? "";
  if (!isUnknownUsageCapability(app)) return app;
  const modelId = input.modelId?.trim() ?? "";
  if (!isUnknownUsageCapability(modelId)) return modelId;
  return "unknown";
}

/** Chart / table label: pipeline, plus app (or model_id) when present. */
export function formatUsageCapabilityLabel(
  pipeline: string,
  capability: string,
): string {
  const pipe = (pipeline || "unknown").trim() || "unknown";
  if (isUnknownUsageCapability(capability)) return pipe;
  const model = capability.trim();
  const shortModel = model.length > 40 ? `${model.slice(0, 38)}…` : model;
  return `${pipe} / ${shortModel}`;
}
