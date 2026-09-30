/**
 * App-manifest capability allow matching for the hosted MCP.
 *
 * Wire capabilities from discovery-service are either `pipeline/model`
 * (`livepeer-example/hello-world`, `transcode/ffmpeg`) or a bare token where the
 * pipeline is the model (`streamdiffusion-sdxl`). The manifest stores the
 * structured `{ pipeline, modelId }` split produced by `splitCapability`, so
 * allow keys are emitted in every spelling a caller may legitimately use —
 * canonical slash, bare token, and the legacy `|` / `:` picker forms — and
 * requests are matched by literal lookup.
 *
 * The requested string is never rewritten. Colons are legal *inside* capability
 * names in this ecosystem (`openai:images.generations`, `video:transcode`), so a
 * colon split is only ever an additional wildcard candidate, evaluated after all
 * literal lookups have missed.
 */

import { splitCapability } from "@/lib/network-catalog";

export type ManifestCapability = {
  pipeline: string;
  modelId: string;
};

/** Manifest `modelId` meaning "every model under this pipeline". */
export const CAPABILITY_WILDCARD = "*";

const SEPARATORS = ["/", "|", ":"] as const;

/** Every allow-key spelling a single manifest entry answers to. */
function allowKeysForManifestCapability(
  pipeline: string,
  modelId: string,
): string[] {
  const keys: string[] = SEPARATORS.map((sep) => `${pipeline}${sep}${modelId}`);
  // Bare wire token: `splitCapability` yields pipeline === model for names with
  // no separating slash, so the manifest round-trips to the original token.
  if (pipeline === modelId) keys.push(pipeline);
  return keys;
}

export function capabilityAllowKeys(
  capabilities: ManifestCapability[],
): Set<string> {
  const keys = new Set<string>();
  for (const capability of capabilities ?? []) {
    const pipeline = capability?.pipeline?.trim();
    const modelId = capability?.modelId?.trim();
    if (!pipeline || !modelId) continue;
    for (const key of allowKeysForManifestCapability(pipeline, modelId)) {
      keys.add(key);
    }
  }
  return keys;
}

export type CanonicalCapability = {
  /** Caller's string, trimmed. Used for literal lookups — never a rewrite. */
  raw: string;
  /** Canonical split; `pipeline === modelId` for a bare token. */
  pipeline: string;
  modelId: string;
  /**
   * Pipelines this request could belong to, for `modelId: "*"` manifest rows.
   * Canonical split first, then the legacy `|` and `:` prefixes. The colon
   * prefix is additive only: `openai:images.generations` matches its literal
   * key first and is never mangled into pipeline `openai`.
   */
  pipelineCandidates: string[];
};

/** Parse a requested capability into canonical parts + wildcard candidates. */
export function canonicalizeCapability(
  capability: string,
): CanonicalCapability | null {
  if (typeof capability !== "string") return null;
  const raw = capability.trim();
  if (!raw) return null;

  const split = splitCapability(raw);
  if (!split) return null;

  const pipelineCandidates: string[] = [];
  const addCandidate = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !pipelineCandidates.includes(trimmed)) {
      pipelineCandidates.push(trimmed);
    }
  };

  addCandidate(split.pipeline);
  const pipeIdx = raw.indexOf("|");
  if (pipeIdx > 0) addCandidate(raw.slice(0, pipeIdx));
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) addCandidate(raw.slice(0, colonIdx));

  return {
    raw,
    pipeline: split.pipeline,
    modelId: split.model,
    pipelineCandidates,
  };
}

/**
 * Does `capability` match any key in `keys`?
 *
 * Separator- and wildcard-aware, and direction-agnostic: the same matching
 * powers the inclusion check (`isCapabilityAllowed`) and the exclusion check
 * (`isCapabilityExcluded`), so a capability spelled in a legacy form is caught
 * by an exclusion exactly as reliably as it would be by an allow entry.
 */
function capabilityMatchesKeys(
  capability: string,
  keys: Set<string>,
): boolean {
  const canonical = canonicalizeCapability(capability);
  if (!canonical) return false;

  // 1. Literal request string. Covers slash, bare-token, `|` and `:` spellings,
  //    including capability names that legitimately contain colons.
  if (keys.has(canonical.raw)) return true;

  // 2. Canonical split re-spelled into the other separators, so a slash request
  //    still resolves against a manifest key stored in a legacy spelling.
  for (const sep of SEPARATORS) {
    if (keys.has(`${canonical.pipeline}${sep}${canonical.modelId}`)) {
      return true;
    }
  }

  // 3. Wildcard manifest rows (`modelId: "*"`), last so literals always win.
  for (const pipeline of canonical.pipelineCandidates) {
    for (const sep of SEPARATORS) {
      if (keys.has(`${pipeline}${sep}${CAPABILITY_WILDCARD}`)) return true;
    }
  }

  return false;
}

/** Inclusion check against manifest allow keys. */
export function isCapabilityAllowed(
  capability: string,
  allow: Set<string>,
): boolean {
  return capabilityMatchesKeys(capability, allow);
}

/** Exclusion check against the app's `excludedCapabilities` keys. */
export function isCapabilityExcluded(
  capability: string,
  deny: Set<string>,
): boolean {
  return capabilityMatchesKeys(capability, deny);
}

/**
 * Split requested capabilities by the app's exclusions — the fail-open gate.
 *
 * Discovery limits capabilities; it does not grant them. Anything the app has
 * not explicitly excluded is permitted, including capabilities absent from the
 * resolved catalog: orchestrators advertise names the catalog does not always
 * enumerate (bare `streamdiffusion-sdxl` vs catalog
 * `live-video-to-video/streamdiffusion-sdxl`), and a catalog gap must not read
 * as a denial.
 *
 * CONTRACT: both arrays hold the caller's ORIGINAL strings, unmodified — the
 * discovery-service `QueryResponse.results` map is keyed by the exact request
 * string.
 */
export function partitionByExclusions(
  requested: string[],
  excludedCapabilities: ManifestCapability[],
): { permitted: string[]; excluded: string[] } {
  const deny = capabilityAllowKeys(excludedCapabilities);
  if (deny.size === 0) return { permitted: [...requested], excluded: [] };

  const permitted: string[] = [];
  const excluded: string[] = [];
  for (const capability of requested) {
    (isCapabilityExcluded(capability, deny) ? excluded : permitted).push(
      capability,
    );
  }
  return { permitted, excluded };
}

/**
 * Filter requested capabilities against the app manifest.
 *
 * CONTRACT: returns the caller's ORIGINAL strings, unmodified. The
 * discovery-service `QueryResponse.results` map is keyed by the exact request
 * string, so rewriting here would break result lookup in `query_orchestrators`.
 */
export function filterAllowedCapabilities(
  requested: string[],
  manifestCapabilities: ManifestCapability[],
): string[] {
  const allow = capabilityAllowKeys(manifestCapabilities);
  return requested.filter((c) => isCapabilityAllowed(c, allow));
}
