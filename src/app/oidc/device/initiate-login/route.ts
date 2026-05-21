import { NextRequest, NextResponse } from "next/server";
import { getInitiateLoginUriForDeviceFlow } from "@/domains/oidc-platform/runtime/clients";
import {
  buildInitiateLoginRedirectUrl,
  initiateSkipCookieOptions,
  thirdPartyInitiateSkipCookieName,
  userCodeFromDeviceTargetLinkUri,
} from "@/platform/oidc/third-party-initiate-login";
import { getIssuer } from "@/platform/oidc/issuer-urls";

/**
 * Server redirect to the RP's registered `initiate_login_uri` with OIDC third-party login parameters.
 * The destination URI is loaded from the database for `client_id` (never from the query string).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl;
  const clientId = url.searchParams.get("client_id")?.trim();
  const targetLinkUri = url.searchParams.get("target_link_uri")?.trim();
  const loginHint = url.searchParams.get("login_hint");

  if (!clientId || !targetLinkUri) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "client_id and target_link_uri are required",
      },
      { status: 400 },
    );
  }

  const initiateLoginUri = await getInitiateLoginUriForDeviceFlow(clientId);
  if (!initiateLoginUri) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Third-party device login is not enabled for this client",
      },
      { status: 400 },
    );
  }

  let dest: string;
  try {
    dest = buildInitiateLoginRedirectUrl(initiateLoginUri, {
      iss: getIssuer(),
      target_link_uri: targetLinkUri,
      login_hint: loginHint,
    });
  } catch {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Invalid initiate_login_uri or target_link_uri",
      },
      { status: 400 },
    );
  }

  const userCode = userCodeFromDeviceTargetLinkUri(targetLinkUri);
  const res = NextResponse.redirect(dest, 302);
  res.cookies.set(
    thirdPartyInitiateSkipCookieName(clientId, userCode),
    "1",
    initiateSkipCookieOptions(),
  );
  return res;
}
