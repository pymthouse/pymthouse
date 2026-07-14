import { getClientSignerApiUrl } from "@/lib/signer-proxy";

export type LivepeerPythonSdkTokenPayload = {
  signer: string;
  discovery?: string;
  signer_headers: {
    Authorization: string;
  };
};

/**
 * Discovery URL for livepeer-python-sdk `--token` payloads.
 * Prefer DISCOVERY_URL; fall back to ORCH_WEBHOOK_URL (production orch pool).
 */
export function getLivepeerPythonSdkDiscoveryUrl(): string | undefined {
  const discovery = process.env.DISCOVERY_URL?.trim();
  if (discovery) return discovery;
  const orch = process.env.ORCH_WEBHOOK_URL?.trim();
  return orch || undefined;
}

export function buildLivepeerPythonSdkTokenPayload(input: {
  apiKey: string;
  signer?: string;
  discovery?: string | null;
}): LivepeerPythonSdkTokenPayload {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("apiKey is required to build a Livepeer Python SDK token");
  }

  const signer = (input.signer ?? getClientSignerApiUrl()).trim();
  if (!signer) {
    throw new Error("signer URL is required to build a Livepeer Python SDK token");
  }

  const discovery =
    input.discovery === undefined
      ? getLivepeerPythonSdkDiscoveryUrl()
      : input.discovery?.trim() || undefined;

  const payload: LivepeerPythonSdkTokenPayload = {
    signer,
    signer_headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
  if (discovery) {
    payload.discovery = discovery;
  }
  return payload;
}

/** Base64-encode the SDK token JSON for use as `--token`. */
export function encodeLivepeerPythonSdkToken(
  payload: LivepeerPythonSdkTokenPayload,
): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Build and encode a `--token` for the minted composite API key. */
export function createLivepeerPythonSdkToken(input: {
  apiKey: string;
  signer?: string;
  discovery?: string | null;
}): string {
  return encodeLivepeerPythonSdkToken(buildLivepeerPythonSdkTokenPayload(input));
}
