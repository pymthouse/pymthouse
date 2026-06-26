import { NextResponse } from "next/server";
import { db } from "@/db/index";
import { signerConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { withAdminGuard } from "@/lib/api-guards";
import { isManagedRemoteSigner, syncSignerStatus } from "@/lib/signer-proxy";

const SUPPORTED_NETWORK = "arbitrum-one-mainnet";

// Duration format: number + unit for live AI capability reports.
const LIVE_AI_CAP_DURATION_REGEX = /^\d+(ns|us|µs|ms|s|m|h)$/;

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return s.startsWith("http://") || s.startsWith("https://");
  } catch {
    return false;
  }
}

function applySignerUrlUpdate(
  value: unknown,
  updates: Record<string, unknown>,
): NextResponse | null {
  if (value === undefined) {
    return null;
  }
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    updates.signerUrl = null;
    return null;
  }
  if (!isValidUrl(raw)) {
    return NextResponse.json(
      { error: "signerUrl must be a valid http(s) URL or empty" },
      { status: 400 },
    );
  }
  updates.signerUrl = raw;
  return null;
}

function applySignerPortUpdate(
  value: unknown,
  updates: Record<string, unknown>,
): NextResponse | null {
  if (value === undefined) {
    return null;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return NextResponse.json(
      { error: "signerPort must be an integer between 1024 and 65535" },
      { status: 400 },
    );
  }
  updates.signerPort = port;
  return null;
}

function applyNetworkUpdate(
  value: unknown,
  updates: Record<string, unknown>,
): NextResponse | null {
  if (value === undefined) {
    return null;
  }
  if (value !== SUPPORTED_NETWORK) {
    return NextResponse.json(
      { error: `Invalid network. Must be: ${SUPPORTED_NETWORK}` },
      { status: 400 },
    );
  }
  updates.network = SUPPORTED_NETWORK;
  return null;
}

function applyRemoteDiscoveryUpdate(
  value: unknown,
  updates: Record<string, unknown>,
): void {
  if (value === undefined) {
    return;
  }
  const enabled = value === true || value === "true";
  updates.remoteDiscovery = enabled ? 1 : 0;
  if (!enabled) {
    updates.orchWebhookUrl = null;
    updates.liveAICapReportInterval = null;
  }
}

function applyOrchWebhookUpdate(
  value: unknown,
  effectiveRemoteDiscovery: boolean,
  updates: Record<string, unknown>,
): NextResponse | null {
  if (value === undefined || !effectiveRemoteDiscovery) {
    return null;
  }
  const url = typeof value === "string" ? value.trim() : "";
  const normalized = url || null;
  if (normalized && !isValidUrl(normalized)) {
    return NextResponse.json(
      { error: "orchWebhookUrl must be a valid http(s) URL" },
      { status: 400 },
    );
  }
  updates.orchWebhookUrl = normalized;
  return null;
}

function applyLiveAICapIntervalUpdate(
  value: unknown,
  effectiveRemoteDiscovery: boolean,
  updates: Record<string, unknown>,
): NextResponse | null {
  if (value === undefined || !effectiveRemoteDiscovery) {
    return null;
  }
  const interval = typeof value === "string" ? value.trim() : "";
  const normalized = interval || null;
  if (normalized && !LIVE_AI_CAP_DURATION_REGEX.test(normalized)) {
    return NextResponse.json(
      {
        error:
          "liveAICapReportInterval must be a valid duration (e.g. 5m, 10s, 1h)",
      },
      { status: 400 },
    );
  }
  updates.liveAICapReportInterval = normalized;
  return null;
}

type SignerPatchComputation = {
  updates: Record<string, unknown>;
  localComposeTouched: boolean;
};

function isLocalComposeFieldTouched(body: Record<string, unknown>): boolean {
  return (
    body.ethRpcUrl !== undefined ||
    body.signerPort !== undefined ||
    body.ethAcctAddr !== undefined ||
    body.remoteDiscovery !== undefined ||
    body.orchWebhookUrl !== undefined ||
    body.liveAICapReportInterval !== undefined
  );
}

function buildSignerUpdateMessage(
  signer: Parameters<typeof isManagedRemoteSigner>[0],
  localComposeTouched: boolean,
): string {
  const remote = isManagedRemoteSigner(signer);
  if (remote) {
    return localComposeTouched
      ? "Platform settings saved. Signer process settings (RPC, port, discovery) must be changed on the remote host."
      : "Platform settings saved.";
  }
  return localComposeTouched
    ? "Config updated. Restart the signer for changes to take effect."
    : "Config updated.";
}

function computeSignerPatch(
  body: Record<string, unknown>,
  current: { remoteDiscovery: number } | undefined,
): SignerPatchComputation | NextResponse {
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    updates.name = body.name;
  }
  const signerUrlError = applySignerUrlUpdate(body.signerUrl, updates);
  if (signerUrlError) {
    return signerUrlError;
  }
  if (body.signerApiKey !== undefined) {
    const trimmed =
      typeof body.signerApiKey === "string" ? body.signerApiKey.trim() : "";
    updates.signerApiKey = trimmed === "" ? null : trimmed;
  }
  const signerPortError = applySignerPortUpdate(body.signerPort, updates);
  if (signerPortError) {
    return signerPortError;
  }
  const networkError = applyNetworkUpdate(body.network, updates);
  if (networkError) {
    return networkError;
  }
  if (body.ethRpcUrl !== undefined) updates.ethRpcUrl = body.ethRpcUrl;
  if (body.ethAcctAddr !== undefined) updates.ethAcctAddr = body.ethAcctAddr;
  if (body.defaultCutPercent !== undefined)
    updates.defaultCutPercent = body.defaultCutPercent;
  if (body.billingMode !== undefined) updates.billingMode = body.billingMode;

  applyRemoteDiscoveryUpdate(body.remoteDiscovery, updates);
  const effectiveRemoteDiscovery =
    updates.remoteDiscovery !== undefined
      ? updates.remoteDiscovery === 1
      : current?.remoteDiscovery === 1;

  const orchWebhookError = applyOrchWebhookUpdate(
    body.orchWebhookUrl,
    effectiveRemoteDiscovery,
    updates,
  );
  if (orchWebhookError) {
    return orchWebhookError;
  }
  const liveAICapIntervalError = applyLiveAICapIntervalUpdate(
    body.liveAICapReportInterval,
    effectiveRemoteDiscovery,
    updates,
  );
  if (liveAICapIntervalError) {
    return liveAICapIntervalError;
  }

  return {
    updates,
    localComposeTouched: isLocalComposeFieldTouched(body),
  };
}

/**
 * GET /api/v1/signer -- Get singleton signer status + config
 */
export const GET = withAdminGuard(async () => {
  const liveStatus = await syncSignerStatus();

  const signerRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const signer = signerRows[0];

  return NextResponse.json({
    signer,
    live: {
      reachable: liveStatus.reachable,
      ethAddress: liveStatus.ethAddress,
    },
  });
});

/**
 * PATCH /api/v1/signer -- Update signer config
 * Changing config requires a restart to take effect.
 */
export const PATCH = withAdminGuard(async (request) => {
  const body = (await request.json()) as Record<string, unknown>;
  const currentRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const current = currentRows[0];

  const computed = computeSignerPatch(body, current);
  if (computed instanceof NextResponse) {
    return computed;
  }

  if (Object.keys(computed.updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 }
    );
  }

  await db
    .update(signerConfig)
    .set(computed.updates)
    .where(eq(signerConfig.id, "default"));

  const updatedRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const updated = updatedRows[0];

  return NextResponse.json({
    signer: updated,
    message: buildSignerUpdateMessage(updated, computed.localComposeTouched),
  });
});

