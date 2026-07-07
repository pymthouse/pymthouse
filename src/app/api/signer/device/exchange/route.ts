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
) {
  try {
    const resolved = await resolveSubjectAccessToken(deviceToken, {
      expectedPublicClientId: context.clientId ?? undefined,
    });

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

const deviceExchangeHandler = createDeviceExchangeHandler({
  mint: mintFromDeviceToken,
  getSignerUrl: () => getClientSignerApiUrl(),
});

export async function POST(request: NextRequest) {
  return deviceExchangeHandler(request);
}
