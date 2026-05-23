import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveSignerRoute,
  resolveAuxSignerRoute,
  SIGNER_ROUTE_LEGACY_REMOTE,
  SIGNER_ROUTE_LPNM_REGISTRY,
  SIGNER_ROUTE_LPNM_ORCHESTRATOR,
} from "@/lib/signing-route";
import type { CachedAppSigningRouting } from "@/lib/signing-routing-cache";
import {
  SIGNING_MODE_DUAL,
  SIGNING_MODE_LEGACY_REMOTE_SIGNER,
  SIGNING_MODE_LPNM_PAYER_DAEMON,
} from "@/lib/signing-modes";

function routing(
  signingMode: string,
  enabledBackends: CachedAppSigningRouting["enabledBackends"],
): CachedAppSigningRouting {
  return {
    publicClientId: "app_test",
    providerAppId: "internal",
    signingMode,
    enabledBackends,
    payerDaemonSocket: null,
    updatedAt: Date.now(),
  };
}

test("registry body routes to LPNM when payer daemon enabled", () => {
  const r = routing(SIGNING_MODE_LPNM_PAYER_DAEMON, ["lpnm_payer_daemon"]);
  const out = resolveSignerRoute(r, { paymentMode: "registry", capability: "x" });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.route, SIGNER_ROUTE_LPNM_REGISTRY);
});

test("registry body rejected on legacy-only app", () => {
  const r = routing(SIGNING_MODE_LEGACY_REMOTE_SIGNER, ["legacy_remote_signer"]);
  const out = resolveSignerRoute(r, { paymentMode: "registry", capability: "x" });
  assert.equal(out.ok, false);
});

test("dual: orchestrator blob uses legacy remote signer", () => {
  const r = routing(SIGNING_MODE_DUAL, [
    "legacy_remote_signer",
    "lpnm_payer_daemon",
  ]);
  const out = resolveSignerRoute(r, { orchestrator: "b64orch" });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.route, SIGNER_ROUTE_LEGACY_REMOTE);
});

test("dual: registry uses LPNM", () => {
  const r = routing(SIGNING_MODE_DUAL, [
    "legacy_remote_signer",
    "lpnm_payer_daemon",
  ]);
  const out = resolveSignerRoute(r, {
    paymentMode: "registry",
    capability: "openai:audio-speech",
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.route, SIGNER_ROUTE_LPNM_REGISTRY);
});

test("lpnm-only: orchestrator blob uses LPNM orchestrator path", () => {
  const r = routing(SIGNING_MODE_LPNM_PAYER_DAEMON, ["lpnm_payer_daemon"]);
  const out = resolveSignerRoute(r, { orchestrator: "b64orch" });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.route, SIGNER_ROUTE_LPNM_ORCHESTRATOR);
});

test("resolveAuxSignerRoute prefers LPNM when legacy disabled", () => {
  const r = routing(SIGNING_MODE_LPNM_PAYER_DAEMON, ["lpnm_payer_daemon"]);
  assert.equal(resolveAuxSignerRoute(r), SIGNER_ROUTE_LPNM_ORCHESTRATOR);
});

test("resolveAuxSignerRoute uses legacy when both enabled (dual)", () => {
  const r = routing(SIGNING_MODE_DUAL, [
    "legacy_remote_signer",
    "lpnm_payer_daemon",
  ]);
  assert.equal(resolveAuxSignerRoute(r), SIGNER_ROUTE_LEGACY_REMOTE);
});
