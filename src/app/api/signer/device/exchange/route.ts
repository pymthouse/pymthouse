import { NextRequest } from "next/server";
import { PmtHouseError } from "@pymthouse/builder-sdk";
import { createDeviceExchangeHandler } from "@pymthouse/builder-sdk/signer/server";
import { hasScope } from "@/lib/auth";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import {
  MintUserSignerTokenError,
  mintSignerJwtForExternalUser,
} from "@/lib/oidc/mint-user-signer-token";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";
import {
  resolveSubjectAccessToken,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";

function scopeStringFromPayload(payload: Record<string, unknown>): string {
  const scopeFromScope =
    typeof payload.scope === "string" ? payload.scope.trim() : "";
  if (scopeFromScope) {
    return scopeFromScope.replace(/\s+/g, " ").trim();
  }
  const scpRaw = payload.scp;
  if (Array.isArray(scpRaw)) {
    return scpRaw.filter((v): v is string => typeof v === "string").join(" ");
  }
  if (typeof scpRaw === "string") {
    return scpRaw.trim();
  }
  return "sign:job";
}

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
      audience: getIssuer(),
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
