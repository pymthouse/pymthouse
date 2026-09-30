import {
  buildDiscoverOrchestratorsUrl,
  normalizeDiscoveryCaps,
} from "@/lib/discovery-service-url";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

export type LivepeerPythonSdkTokenPayload = {
  signer: string;
  discovery?: string;
  caps?: string[];
  signer_headers: {
    Authorization: string;
  };
};

/**
 * Default discovery URL for livepeer-python-sdk `--token` payloads:
 * `{signer}/discover-orchestrators`.
 */
export function getLivepeerPythonSdkDiscoveryUrl(
  signerUrl?: string,
): string | undefined {
  const signer = (signerUrl ?? getClientSignerApiUrl()).trim();
  if (!signer) return undefined;
  return buildDiscoverOrchestratorsUrl(signer);
}

export function buildLivepeerPythonSdkTokenPayload(input: {
  apiKey: string;
  signer?: string;
  discovery?: string | null;
  caps?: readonly string[] | null;
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
      ? getLivepeerPythonSdkDiscoveryUrl(signer)
      : input.discovery?.trim() || undefined;

  const caps = normalizeDiscoveryCaps(input.caps ?? undefined);

  const payload: LivepeerPythonSdkTokenPayload = {
    signer,
    signer_headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
  if (discovery) {
    payload.discovery = discovery;
  }
  if (caps) {
    payload.caps = caps;
  }
  return payload;
}

/** Base64-encode the SDK token JSON for use as `--token`. */
export function encodeLivepeerPythonSdkToken(
  payload: LivepeerPythonSdkTokenPayload,
): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Build and encode a `--token` for the minted API key (`pmth_*` or composite). */
export function createLivepeerPythonSdkToken(input: {
  apiKey: string;
  signer?: string;
  discovery?: string | null;
  caps?: readonly string[] | null;
}): string {
  return encodeLivepeerPythonSdkToken(buildLivepeerPythonSdkTokenPayload(input));
}
