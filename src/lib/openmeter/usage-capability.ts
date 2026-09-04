/**
 * Live Runner `app` on create_signed_ticket events is the capability name
 * (e.g. `live-video-to-video/scope`). `model_id` is optional and often empty.
 *
 * Resolution order matches signed-ticket ingest: `app`, historical `model_id`,
 * then `live-video-to-video` pipeline when both are missing.
 */

import {
  formatModelAttributionLabel,
  resolveSignedTicketAppAttribution,
} from "./signed-ticket-attribution";

export { isUnknownUsageCapability } from "./signed-ticket-attribution";

/** Prefer event `app` when `model_id` is missing or unknown. */
export function capabilityFromUsageFields(input: {
  app?: string | null;
  modelId?: string | null;
  pipeline?: string | null;
}): string {
  return resolveSignedTicketAppAttribution({
    app: input.app,
    pipeline: input.pipeline,
    modelId: input.modelId,
  });
}

/** Chart / table label: pipeline, plus app (or model_id) when present. */
export function formatUsageCapabilityLabel(
  pipeline: string,
  capability: string,
): string {
  return formatModelAttributionLabel(pipeline, capability);
}
