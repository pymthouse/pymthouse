/**
 * Per-request signing route inference (hot path: no DB, no catalog).
 *
 * python-gateway chooses the envelope:
 * - RegistryPaymentSession → paymentMode "registry" + capability/offering/…
 * - PaymentSession → orchestrator b64 OrchestratorInfo
 */

import { isRegistryPaymentMode } from "@/lib/signer-lpnm/registry-payment";
import {
  SIGNING_MODE_DUAL,
  type SigningBackend,
} from "@/lib/signing-modes";
import type { CachedAppSigningRouting } from "@/lib/signing-routing-cache";

export const SIGNER_ROUTE_LEGACY_REMOTE = "legacy_remote" as const;
export const SIGNER_ROUTE_LPNM_REGISTRY = "lpnm_registry" as const;
export const SIGNER_ROUTE_LPNM_ORCHESTRATOR = "lpnm_orchestrator" as const;

export type SignerRoute =
  | typeof SIGNER_ROUTE_LEGACY_REMOTE
  | typeof SIGNER_ROUTE_LPNM_REGISTRY
  | typeof SIGNER_ROUTE_LPNM_ORCHESTRATOR;

export type ResolveSignerRouteResult =
  | { ok: true; route: SignerRoute }
  | { ok: false; message: string };

function hasOrchestratorBlob(body: Record<string, unknown>): boolean {
  const orch =
    typeof body.orchestrator === "string"
      ? body.orchestrator.trim()
      : typeof body.Orchestrator === "string"
        ? body.Orchestrator.trim()
        : "";
  return orch.length > 0;
}

function backendsInclude(
  enabled: SigningBackend[],
  backend: SigningBackend,
): boolean {
  return enabled.includes(backend);
}

/**
 * Resolve signing route from request body and app-enabled backends.
 * Dual mode: registry → LPNM; orchestrator blob → legacy go-livepeer.
 */
export function resolveSignerRoute(
  routing: CachedAppSigningRouting,
  body: Record<string, unknown>,
): ResolveSignerRouteResult {
  const enabled = routing.enabledBackends;
  const hasLegacy = backendsInclude(enabled, "legacy_remote_signer");
  const hasLpnm = backendsInclude(enabled, "lpnm_payer_daemon");
  const dual = routing.signingMode === SIGNING_MODE_DUAL;

  if (isRegistryPaymentMode(body)) {
    if (!hasLpnm) {
      return {
        ok: false,
        message:
          "Registry payments (paymentMode=registry) require LPNM payer-daemon signing on this app",
      };
    }
    return { ok: true, route: SIGNER_ROUTE_LPNM_REGISTRY };
  }

  if (hasOrchestratorBlob(body)) {
    if (dual && hasLegacy) {
      return { ok: true, route: SIGNER_ROUTE_LEGACY_REMOTE };
    }
    if (hasLpnm && !dual) {
      return { ok: true, route: SIGNER_ROUTE_LPNM_ORCHESTRATOR };
    }
    if (hasLegacy) {
      return { ok: true, route: SIGNER_ROUTE_LEGACY_REMOTE };
    }
    return {
      ok: false,
      message:
        "Orchestrator-based payments require legacy remote signer or LPNM on this app",
    };
  }

  if (hasLegacy) {
    return { ok: true, route: SIGNER_ROUTE_LEGACY_REMOTE };
  }

  return {
    ok: false,
    message: "No signing backend is enabled for this app",
  };
}

export function signerRouteUsesLpnm(route: SignerRoute): boolean {
  return (
    route === SIGNER_ROUTE_LPNM_REGISTRY ||
    route === SIGNER_ROUTE_LPNM_ORCHESTRATOR
  );
}

export function signerRouteRequiresLegacySigner(route: SignerRoute): boolean {
  return route === SIGNER_ROUTE_LEGACY_REMOTE;
}

/** sign-orchestrator-info, sign-byoc-job, discover-orchestrators (no payment envelope). */
export function resolveAuxSignerRoute(
  routing: CachedAppSigningRouting,
): typeof SIGNER_ROUTE_LEGACY_REMOTE | typeof SIGNER_ROUTE_LPNM_ORCHESTRATOR {
  const hasLegacy = backendsInclude(
    routing.enabledBackends,
    "legacy_remote_signer",
  );
  const hasLpnm = backendsInclude(routing.enabledBackends, "lpnm_payer_daemon");
  if (hasLpnm && !hasLegacy) {
    return SIGNER_ROUTE_LPNM_ORCHESTRATOR;
  }
  return SIGNER_ROUTE_LEGACY_REMOTE;
}
