import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/index";
import { signerConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { withAdminGuard } from "@/lib/api-guards";
import { isManagedRemoteSigner, syncSignerStatus } from "@/lib/signer-proxy";

const SUPPORTED_NETWORK = "arbitrum-one-mainnet";

// Duration format: number + unit (s, m, h) e.g. 5m, 10s, 1h
const DURATION_REGEX = /^\d+[smh]$/;

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return s.startsWith("http://") || s.startsWith("https://");
  } catch {
    return false;
  }
}

function isValidDuration(s: string): boolean {
  return DURATION_REGEX.test(s);
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
  const body = await request.json();
  const updates: Record<string, unknown> = {};
  const currentRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const current = currentRows[0];

  if (body.name !== undefined) updates.name = body.name;
  if (body.signerUrl !== undefined) {
    const raw = typeof body.signerUrl === "string" ? body.signerUrl.trim() : "";
    if (raw === "") {
      updates.signerUrl = null;
    } else if (!isValidUrl(raw)) {
      return NextResponse.json(
        { error: "signerUrl must be a valid http(s) URL or empty" },
        { status: 400 }
      );
    } else {
      updates.signerUrl = raw;
    }
  }
  if (body.signerApiKey !== undefined) {
    const trimmed =
      typeof body.signerApiKey === "string" ? body.signerApiKey.trim() : "";
    updates.signerApiKey = trimmed === "" ? null : trimmed;
  }
  if (body.signerPort !== undefined) {
    const port = Number(body.signerPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return NextResponse.json(
        { error: "signerPort must be an integer between 1024 and 65535" },
        { status: 400 }
      );
    }
    updates.signerPort = port;
  }
  if (body.network !== undefined) {
    if (body.network !== SUPPORTED_NETWORK) {
      return NextResponse.json(
        { error: `Invalid network. Must be: ${SUPPORTED_NETWORK}` },
        { status: 400 }
      );
    }
    updates.network = SUPPORTED_NETWORK;
  }
  if (body.ethRpcUrl !== undefined) updates.ethRpcUrl = body.ethRpcUrl;
  if (body.ethAcctAddr !== undefined) updates.ethAcctAddr = body.ethAcctAddr;
  if (body.defaultCutPercent !== undefined)
    updates.defaultCutPercent = body.defaultCutPercent;
  if (body.billingMode !== undefined) updates.billingMode = body.billingMode;

  // Remote discovery: when enabled, orchWebhookUrl and liveAICapReportInterval are used
  if (body.remoteDiscovery !== undefined) {
    const rd = body.remoteDiscovery === true || body.remoteDiscovery === "true";
    updates.remoteDiscovery = rd ? 1 : 0;
    if (!rd) {
      updates.orchWebhookUrl = null;
      updates.liveAICapReportInterval = null;
    }
  }
  const effectiveRemoteDiscovery =
    updates.remoteDiscovery !== undefined
      ? updates.remoteDiscovery === 1
      : current?.remoteDiscovery === 1;

  if (body.orchWebhookUrl !== undefined) {
    if (effectiveRemoteDiscovery) {
      const url = body.orchWebhookUrl?.trim() || null;
      if (url && !isValidUrl(url)) {
        return NextResponse.json(
          { error: "orchWebhookUrl must be a valid http(s) URL" },
          { status: 400 }
        );
      }
      updates.orchWebhookUrl = url;
    }
  }
  if (body.liveAICapReportInterval !== undefined) {
    if (effectiveRemoteDiscovery) {
      const val = body.liveAICapReportInterval?.trim() || null;
      if (val && !/^\d+(ns|us|µs|ms|s|m|h)$/.test(val)) {
        return NextResponse.json(
          {
            error:
              "liveAICapReportInterval must be a valid duration (e.g. 5m, 10s, 1h)",
          },
          { status: 400 }
        );
      }
      updates.liveAICapReportInterval = val;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 }
    );
  }

  await db
    .update(signerConfig)
    .set(updates)
    .where(eq(signerConfig.id, "default"));

  const updatedRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const updated = updatedRows[0];

  const remote = isManagedRemoteSigner(updated);
  const localComposeTouched =
    body.ethRpcUrl !== undefined ||
    body.signerPort !== undefined ||
    body.ethAcctAddr !== undefined ||
    body.remoteDiscovery !== undefined ||
    body.orchWebhookUrl !== undefined ||
    body.liveAICapReportInterval !== undefined;

  let message = "Config updated.";
  if (remote) {
    message = localComposeTouched
      ? "Platform settings saved. Signer process settings (RPC, port, discovery) must be changed on the remote host."
      : "Platform settings saved.";
  } else if (localComposeTouched) {
    message = "Config updated. Restart the signer for changes to take effect.";
  }

  return NextResponse.json({
    signer: updated,
    message,
  });
});

