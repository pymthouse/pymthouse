import { NextRequest } from "next/server";
import { PmtHouseError } from "@pymthouse/builder-sdk";
import { createDeviceExchangeHandler } from "@pymthouse/builder-sdk/signer/server";
import { hasScope } from "@/lib/auth";
import {
  MintUserSignerTokenError,
  mintSignerJwtForExternalUser,
} from "@/lib/oidc/mint-user-signer-token";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";
import {
  resolveSubjectAccessToken,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";
import { scopeStringFromPayload } from "@/lib/oidc/scope-string";

async function mintFromDeviceToken(
  deviceToken: string,
  context: { scope?: string; clientId?: string },
  onResolvedPublicClientId?: (publicClientId: string) => void,
) {
  try {
    const resolved = await resolveSubjectAccessToken(deviceToken, {
      expectedPublicClientId: context.clientId ?? undefined,
    });

    // Report the token-verified public client id so the caller can pick the
    // signer version (latest vs stable) for this app. Authoritative source is
    // the subject token, not the client-supplied body clientId.
    onResolvedPublicClientId?.(resolved.publicClientId);

    const scopeStr = scopeStringFromPayload(resolved.payload);
    if (!hasScope(scopeStr, "sign:job")) {
      throw new PmtHouseError("subject_token must include sign:job scope", {
        status: 400,
        code: "invalid_grant",
      });
    }

    return mintSignerJwtForExternalUser({
      publicClientId: resolved.publicClientId,
      developerAppId: resolved.developerAppId,
      externalUserId: resolved.externalUserId,
    });
  } catch (error) {
    if (error instanceof MintUserSignerTokenError) {
      throw new PmtHouseError(error.message, {
        status: error.status,
        code: error.code,
      });
    }
    if (error instanceof SubjectAccessTokenResolveError) {
      throw new PmtHouseError(error.message, {
        status: error.status,
        code: error.code,
      });
    }
    if (
      error instanceof Error &&
      error.message.includes("subject_token sub does not map")
    ) {
      throw new PmtHouseError(error.message, {
        status: 400,
        code: "invalid_grant",
      });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  // Per-request handler: capture the token-resolved public client id during mint
  // so the returned signer_url points at this app's signer version (latest vs
  // stable). The SDK invokes getSignerUrl only after mint has awaited.
  let signerAppClientId: string | undefined;
  const deviceExchangeHandler = createDeviceExchangeHandler({
    mint: (deviceToken, context) =>
      mintFromDeviceToken(deviceToken, context, (publicClientId) => {
        signerAppClientId = publicClientId;
      }),
    getSignerUrl: () => getClientSignerApiUrl(signerAppClientId),
  });
  return deviceExchangeHandler(request);
}
