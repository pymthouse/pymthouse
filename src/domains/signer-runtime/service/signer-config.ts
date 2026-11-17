const SUPPORTED_NETWORK = "arbitrum-one-mainnet";
const DURATION_REGEX = /^\d+[smh]$/;
const GO_DURATION_REGEX = /^\d+(ns|us|µs|ms|s|m|h)$/;

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return value.startsWith("http://") || value.startsWith("https://");
  } catch {
    return false;
  }
}

export function parseTail(value: string | null): number {
  const defaultTail = 50;
  const maxTail = 1000;
  if (!value || !/^\d+$/.test(value)) return defaultTail;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return defaultTail;
  return Math.min(parsed, maxTail);
}

export function parseSignerConfigUpdate(params: {
  body: Record<string, unknown>;
  current:
    | {
        remoteDiscovery: number;
      }
    | undefined;
}):
  | { ok: true; updates: Record<string, unknown> }
  | { ok: false; status: 400; body: { error: string } } {
  const { body, current } = params;
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.signerUrl !== undefined) {
    const raw = typeof body.signerUrl === "string" ? body.signerUrl.trim() : "";
    if (raw === "") {
      updates.signerUrl = null;
    } else if (!isValidUrl(raw)) {
      return {
        ok: false,
        status: 400,
        body: { error: "signerUrl must be a valid http(s) URL or empty" },
      };
    } else {
      updates.signerUrl = raw;
    }
  }
  if (body.signerApiKey !== undefined) {
    const trimmed = typeof body.signerApiKey === "string" ? body.signerApiKey.trim() : "";
    updates.signerApiKey = trimmed === "" ? null : trimmed;
  }
  if (body.signerPort !== undefined) {
    const port = Number(body.signerPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return {
        ok: false,
        status: 400,
        body: { error: "signerPort must be an integer between 1024 and 65535" },
      };
    }
    updates.signerPort = port;
  }
  if (body.network !== undefined) {
    if (body.network !== SUPPORTED_NETWORK) {
      return {
        ok: false,
        status: 400,
        body: { error: `Invalid network. Must be: ${SUPPORTED_NETWORK}` },
      };
    }
    updates.network = SUPPORTED_NETWORK;
  }
  if (body.ethRpcUrl !== undefined) updates.ethRpcUrl = body.ethRpcUrl;
  if (body.ethAcctAddr !== undefined) updates.ethAcctAddr = body.ethAcctAddr;
  if (body.defaultCutPercent !== undefined) updates.defaultCutPercent = body.defaultCutPercent;
  if (body.billingMode !== undefined) updates.billingMode = body.billingMode;

  if (body.remoteDiscovery !== undefined) {
    const enabled = body.remoteDiscovery === true || body.remoteDiscovery === "true";
    updates.remoteDiscovery = enabled ? 1 : 0;
    if (!enabled) {
      updates.orchWebhookUrl = null;
      updates.liveAICapReportInterval = null;
    }
  }
  const effectiveRemoteDiscovery =
    updates.remoteDiscovery !== undefined
      ? updates.remoteDiscovery === 1
      : current?.remoteDiscovery === 1;

  if (body.orchWebhookUrl !== undefined && effectiveRemoteDiscovery) {
    const url = typeof body.orchWebhookUrl === "string" ? body.orchWebhookUrl.trim() : "";
    if (url && !isValidUrl(url)) {
      return {
        ok: false,
        status: 400,
        body: { error: "orchWebhookUrl must be a valid http(s) URL" },
      };
    }
    updates.orchWebhookUrl = url || null;
  }
  if (body.liveAICapReportInterval !== undefined && effectiveRemoteDiscovery) {
    const value =
      typeof body.liveAICapReportInterval === "string"
        ? body.liveAICapReportInterval.trim()
        : "";
    if (value && !GO_DURATION_REGEX.test(value)) {
      return {
        ok: false,
        status: 400,
        body: {
          error:
            "liveAICapReportInterval must be a valid duration (e.g. 5m, 10s, 1h)",
        },
      };
    }
    updates.liveAICapReportInterval = value || null;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, status: 400, body: { error: "No valid fields to update" } };
  }

  return { ok: true, updates };
}

export function isValidDuration(value: string): boolean {
  return DURATION_REGEX.test(value);
}
