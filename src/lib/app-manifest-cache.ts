import type { AppManifestResponse } from "@/lib/discovery-allowlist";
import { buildAppManifestForApp } from "@/lib/app-manifest";
import { getProviderApp } from "@/lib/provider-apps";
import {
  resolvePaymentPipelineModelConstraint,
  resolveRequestPipelineModelConstraint,
  type PipelineModelConstraint,
} from "@/lib/billing-runtime";
import type { AuthResult } from "@/lib/auth";

export type ManifestPolicySource = "manifest_get" | "manifest_put" | "token_mint" | "test";

export interface CachedManifestPolicy {
  publicClientId: string;
  manifestVersion: string;
  allowedPipelines: Set<string>;
  allowedPipelineModels: Set<string>;
  updatedAt: number;
  source?: ManifestPolicySource;
}

export interface ManifestEnforcementResult {
  ok: true;
  constraint: { pipeline: string; modelId?: string };
}

export interface ManifestEnforcementFailure {
  ok: false;
  status: number;
  body: {
    error: string;
    error_description: string;
    pipeline?: string;
    modelId?: string;
    manifestVersion?: string;
  };
}

const policyByPublicClientId = new Map<string, CachedManifestPolicy>();

function pipelineModelKey(pipeline: string, modelId: string): string {
  return `${pipeline.trim()}|${modelId.trim()}`;
}

export function buildCachedManifestPolicy(
  publicClientId: string,
  manifest: AppManifestResponse,
  source?: ManifestPolicySource,
): CachedManifestPolicy {
  const allowedPipelines = new Set<string>();
  const allowedPipelineModels = new Set<string>();

  for (const cap of manifest.capabilities) {
    const pipeline = cap.pipeline.trim();
    const modelId = cap.modelId.trim();
    if (!pipeline || !modelId) continue;
    allowedPipelines.add(pipeline);
    allowedPipelineModels.add(pipelineModelKey(pipeline, modelId));
  }

  return {
    publicClientId,
    manifestVersion: manifest.manifestVersion,
    allowedPipelines,
    allowedPipelineModels,
    updatedAt: Date.now(),
    source,
  };
}

export function publishCachedManifestPolicy(
  publicClientId: string,
  manifest: AppManifestResponse,
  source?: ManifestPolicySource,
): CachedManifestPolicy {
  const policy = buildCachedManifestPolicy(publicClientId, manifest, source);
  policyByPublicClientId.set(publicClientId, policy);
  return policy;
}

export function getCachedManifestPolicy(
  publicClientId: string,
): CachedManifestPolicy | undefined {
  return policyByPublicClientId.get(publicClientId);
}

export function resetManifestPolicyCacheForTests(): void {
  policyByPublicClientId.clear();
}

export function seedCachedManifestPolicyForTests(
  publicClientId: string,
  manifest: AppManifestResponse,
): CachedManifestPolicy {
  return publishCachedManifestPolicy(publicClientId, manifest, "test");
}

/**
 * Warm the signer manifest cache from DB + NaaP catalog (off the signing hot path).
 */
export async function warmAppManifestCacheForPublicClient(
  publicClientId: string,
  source?: ManifestPolicySource,
): Promise<CachedManifestPolicy | null> {
  const app = await getProviderApp(publicClientId);
  if (!app) return null;
  const { warmAppSigningRoutingCache } = await import(
    "@/lib/signing-routing-cache"
  );
  await warmAppSigningRoutingCache(publicClientId);
  const manifest = await buildAppManifestForApp(app.id);
  return publishCachedManifestPolicy(publicClientId, manifest, source);
}

const MANIFEST_WARM_RETRY_DELAYS_MS = [0, 50, 150] as const;

/**
 * Warm manifest cache with short backoff retries (token mint / enforcement paths).
 */
export async function warmAppManifestCacheForPublicClientWithRetry(
  publicClientId: string,
  source?: ManifestPolicySource,
): Promise<CachedManifestPolicy | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MANIFEST_WARM_RETRY_DELAYS_MS.length; attempt++) {
    const delayMs = MANIFEST_WARM_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const policy = await warmAppManifestCacheForPublicClient(publicClientId, source);
      if (policy) return policy;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    console.warn(
      `[manifest-cache] warmAppManifestCacheForPublicClient failed after ${MANIFEST_WARM_RETRY_DELAYS_MS.length} attempts`,
      { publicClientId, source, err: lastError },
    );
  }
  return null;
}

/**
 * Resolve pipeline (required) and optional modelId for manifest enforcement.
 * Does not require modelId when only pipeline fields are present on the body.
 */
export async function resolveSigningPipelineConstraint(
  requestBody: Record<string, unknown>,
): Promise<{ pipeline: string; modelId?: string } | null> {
  const pipeline =
    pickTrimmedString(requestBody, "pipeline") ??
    pickTrimmedString(requestBody, "Pipeline") ??
    pickTrimmedString(requestBody, "capability") ??
    pickTrimmedString(requestBody, "Capability");
  const modelId =
    pickTrimmedString(requestBody, "modelId") ??
    pickTrimmedString(requestBody, "ModelID") ??
    pickTrimmedString(requestBody, "modelID") ??
    pickTrimmedString(requestBody, "model") ??
    pickTrimmedString(requestBody, "Model") ??
    pickTrimmedString(requestBody, "offering") ??
    pickTrimmedString(requestBody, "Offering");

  if (pipeline) {
    return modelId ? { pipeline, modelId } : { pipeline };
  }

  const full: PipelineModelConstraint | null =
    resolveRequestPipelineModelConstraint(requestBody);
  if (full) {
    return { pipeline: full.pipeline, modelId: full.modelId };
  }

  const fromCaps = await resolvePaymentPipelineModelConstraint(requestBody);
  if (fromCaps) {
    return { pipeline: fromCaps.pipeline, modelId: fromCaps.modelId };
  }

  return null;
}

function pickTrimmedString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const v = body[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

export function isPipelineAllowedByPolicy(
  policy: CachedManifestPolicy,
  pipeline: string,
  modelId?: string,
): boolean {
  const p = pipeline.trim();
  if (!p) return false;

  if (modelId?.trim()) {
    return policy.allowedPipelineModels.has(pipelineModelKey(p, modelId));
  }

  if (!policy.allowedPipelines.has(p)) {
    return false;
  }

  for (const key of policy.allowedPipelineModels) {
    if (key.startsWith(`${p}|`)) {
      return true;
    }
  }
  return false;
}

/**
 * Synchronous manifest check for signer proxy (no DB). Call before forwardToSigner.
 */
export async function enforceCachedManifestPolicy(
  requestBody: Record<string, unknown>,
  auth: AuthResult,
): Promise<ManifestEnforcementResult | ManifestEnforcementFailure> {
  const publicClientId = auth.appId?.trim();
  if (!publicClientId) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "capability_not_allowed",
        error_description: "Signing requires an app-scoped token with client_id",
      },
    };
  }

  const constraint = await resolveSigningPipelineConstraint(requestBody);
  if (!constraint?.pipeline?.trim()) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "capability_not_allowed",
        error_description:
          "Signing requires a resolvable pipeline (pipeline field or derivable capabilities)",
      },
    };
  }

  let policy = getCachedManifestPolicy(publicClientId);
  policy ??=
    // Dev servers restart frequently and clear process-local caches. Try an
    // on-demand warm once before failing the request.
    await warmAppManifestCacheForPublicClientWithRetry(
      publicClientId,
      "token_mint",
    );
  if (!policy) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "manifest_cache_unavailable",
        error_description:
          "App manifest policy is not loaded; retry after token issuance or manifest refresh",
      },
    };
  }

  const pipeline = constraint.pipeline.trim();
  const modelId = constraint.modelId?.trim();

  if (!isPipelineAllowedByPolicy(policy, pipeline, modelId)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "capability_not_allowed",
        error_description: modelId
          ? `Pipeline/model is not allowed by the app manifest: ${pipeline}/${modelId}`
          : `Pipeline is not allowed by the app manifest: ${pipeline}`,
        pipeline,
        modelId,
        manifestVersion: policy.manifestVersion,
      },
    };
  }

  return {
    ok: true,
    constraint: modelId ? { pipeline, modelId } : { pipeline },
  };
}
