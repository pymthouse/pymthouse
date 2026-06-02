import { createHash } from "node:crypto";

import {
  type AppManifestResolved,
  type AppManifestResponse,
  type DiscoveryAllowlistDocument,
} from "@/lib/discovery-allowlist";

function sortCap(
  a: { pipeline: string; modelId: string },
  b: { pipeline: string; modelId: string },
): number {
  const p = a.pipeline.localeCompare(b.pipeline);
  return p !== 0 ? p : a.modelId.localeCompare(b.modelId);
}

export function computeManifestRevision(
  data: AppManifestResolved | null,
): string {
  if (data == null) {
    return "unavailable";
  }
  const caps = [...data.capabilities].sort(sortCap);
  const excl = [...data.excludedCapabilities].sort(sortCap);
  if (caps.length === 0 && excl.length === 0) {
    return "empty";
  }
  return createHash("sha256")
    .update(JSON.stringify({ capabilities: caps, excludedCapabilities: excl }))
    .digest("hex")
    .slice(0, 24);
}

export function toAppManifestResponse(resolved: AppManifestResolved): AppManifestResponse {
  return {
    ...resolved,
    manifestVersion: computeManifestRevision(resolved),
  };
}

/** Integrator fail-open: no exclusions; NaaP allows full catalog. Used by GET …/manifest (no NaaP/DB resolve). */
export const ALLOW_ALL_MANIFEST_RESPONSE: AppManifestResponse = toAppManifestResponse({
  capabilities: [],
  excludedCapabilities: [],
});

export const ALLOW_ALL_MANIFEST_ETAG = '"manifest-allow-all"';

/**
 * When the pipeline catalog cannot be loaded, return stored exclusions with empty
 * `capabilities` (integrator fail-open). Dashboard UI uses `/pipeline-catalog` separately.
 */
export function buildManifestWhenCatalogUnavailable(
  excluded: DiscoveryAllowlistDocument | null,
): AppManifestResponse {
  const excludedCapabilities = [...(excluded?.capabilities ?? [])].sort(sortCap);
  return toAppManifestResponse({
    capabilities: [],
    excludedCapabilities,
  });
}
