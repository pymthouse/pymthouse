/**
 * Signed-ticket model attribution from the remote signer CloudEvent.
 *
 * The signer now sends the model name on `data.app` (for example
 * `livepeer-example/hello-world`). `model_id` is no longer populated.
 * `live-video-to-video` still writes a pipeline but no app — use the
 * pipeline name as the app attribution in that case only.
 *
 * Read paths also accept historical `model_id` so OpenMeter rows ingested
 * before this cutover still group correctly.
 */

export const LIVE_VIDEO_TO_VIDEO_PIPELINE = "live-video-to-video";

const UNKNOWN_ATTRIBUTION = "unknown";

export function isUnknownUsageCapability(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim() ?? "";
  return !trimmed || trimmed.toLowerCase() === UNKNOWN_ATTRIBUTION;
}

function nonemptyAttribution(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (isUnknownUsageCapability(trimmed)) {
    return null;
  }
  return trimmed;
}

export function resolveSignedTicketAppAttribution(input: {
  app?: string | null;
  pipeline?: string | null;
  modelId?: string | null;
}): string {
  const fromApp = nonemptyAttribution(input.app);
  if (fromApp) {
    return fromApp;
  }
  const fromModel = nonemptyAttribution(input.modelId);
  if (fromModel) {
    return fromModel;
  }
  const pipeline = input.pipeline?.trim() || "";
  if (pipeline === LIVE_VIDEO_TO_VIDEO_PIPELINE) {
    return LIVE_VIDEO_TO_VIDEO_PIPELINE;
  }
  return UNKNOWN_ATTRIBUTION;
}

/** Chart / request-history label: pipeline, plus app when it adds information. */
export function formatModelAttributionLabel(
  pipeline: string,
  attribution: string,
): string {
  const pipe = (pipeline || UNKNOWN_ATTRIBUTION).trim() || UNKNOWN_ATTRIBUTION;
  const model = (attribution || "").trim();
  if (isUnknownUsageCapability(model) || model === pipe) {
    return pipe;
  }
  const shortModel = model.length > 40 ? `${model.slice(0, 38)}…` : model;
  return `${pipe} / ${shortModel}`;
}
