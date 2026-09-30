import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

/** True only for loopback hostnames (cleartext HTTP allowed in non-production). */
function isLocalhostHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

/**
 * OIDC Core — "Initiating Login from a Third Party" (initiate_login_uri).
 * Query parameters: iss (REQUIRED), login_hint (OPTIONAL), target_link_uri (REQUIRED for our use).
 */
export function normalizeIssuerUrl(iss: string): string {
  try {
    const u = new URL(iss);
    return u.href.replace(/\/+$/, "");
  } catch {
    return iss.trim();
  }
}

export function issuerMatchesExpected(iss: string | null, expectedIssuer: string): boolean {
  if (!iss || !iss.trim()) return false;
  try {
    return normalizeIssuerUrl(iss) === normalizeIssuerUrl(expectedIssuer);
  } catch {
    return false;
  }
}

export function buildDeviceFlowTargetLinkUri(searchParams: {
  user_code?: string | null;
  client_id?: string | null;
  iss?: string | null;
  login_hint?: string | null;
}): string {
  const base = new URL("/oidc/device", getPublicOrigin());
  if (searchParams.user_code) {
    base.searchParams.set("user_code", searchParams.user_code);
  }
  if (searchParams.client_id) {
    base.searchParams.set("client_id", searchParams.client_id);
  }
  if (searchParams.iss) {
    base.searchParams.set("iss", searchParams.iss);
  }
  if (searchParams.login_hint) {
    base.searchParams.set("login_hint", searchParams.login_hint);
  }
  return base.href;
}

/**
 * Registered initiate_login_uri must use HTTPS (HTTP allowed on loopback hosts only in non-production).
 */
export function validateInitiateLoginUri(uri: string): void {
  const u = new URL(uri);
  if (u.hash) {
    throw new Error("initiate_login_uri must not include a fragment");
  }
  if (u.protocol === "https:") {
    return;
  }
  if (
    process.env.NODE_ENV !== "production" &&
    u.protocol === "http:" &&
    isLocalhostHostname(u.hostname)
  ) {
    return;
  }
  throw new Error("initiate_login_uri must use HTTPS");
}

/**
 * node-oidc-provider validates `initiate_login_uri` as HTTPS-only (no localhost HTTP exception).
 * Forward only those values onto ClientMetadata; loopback HTTP in dev stays out of the provider
 * so /device/auth does not 400 — device flow still uses the DB via getInitiateLoginUriForDeviceFlow().
 */
export function initiateLoginUriAcceptedByOidcProvider(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `target_link_uri` passed to the RP must return the browser to our public device page only.
 */
export function validateDeviceFlowTargetLinkUri(targetLinkUri: string): void {
  const expectedOrigin = new URL(getPublicOrigin()).origin;
  const u = new URL(targetLinkUri);
  if (u.origin !== expectedOrigin) {
    throw new Error("target_link_uri must use this site's origin");
  }
  if (u.pathname !== "/oidc/device") {
    throw new Error("target_link_uri path must be /oidc/device");
  }
  if (u.hash) {
    throw new Error("target_link_uri must not include a fragment");
  }
}

export function buildInitiateLoginRedirectUrl(
  initiateLoginUri: string,
  args: {
    iss: string;
    target_link_uri: string;
    login_hint?: string | null;
  },
): string {
  validateInitiateLoginUri(initiateLoginUri);
  validateDeviceFlowTargetLinkUri(args.target_link_uri);
  const dest = new URL(initiateLoginUri);
  dest.searchParams.set("iss", args.iss);
  dest.searchParams.set("target_link_uri", args.target_link_uri);
  if (args.login_hint && args.login_hint.trim()) {
    dest.searchParams.set("login_hint", args.login_hint.trim());
  }
  return dest.toString();
}

/**
 * Verification URIs for an RFC 8628 device authorization response.
 *
 * `verification_uri` stays on this authorization server because RFC 8628 3.2
 * expects end users to type it by hand. `verification_uri_complete` is
 * "designed for non-textual transmission" and has no AS-origin constraint, so
 * when the app federates device approval it targets the RP's registered
 * `initiate_login_uri` directly (OIDC Core third-party initiated login). The
 * browser never transits `/oidc/device/initiate-login`. Return trips to
 * `target_link_uri` must not re-federate once the DeviceCode is bound — see
 * `/oidc/device` which gates on `isDeviceCodeBound`. Falls back to the
 * authorization-server URL whenever the RP target cannot be built.
 */
export function deviceAuthVerificationUris(args: {
  userCode?: string | null;
  clientId?: string | null;
  issuer: string;
  externalOrigin: string;
  initiateLoginUri?: string | null;
  loginHint?: string | null;
}): { verification_uri: string; verification_uri_complete?: string } {
  const verification_uri = `${args.externalOrigin}/oidc/device`;
  if (!args.userCode) {
    return { verification_uri };
  }

  const qs = new URLSearchParams();
  qs.set("user_code", args.userCode);
  if (args.clientId) {
    qs.set("client_id", args.clientId);
  }
  qs.set("iss", args.issuer);
  const onAuthorizationServer = `${verification_uri}?${qs.toString()}`;

  if (!args.initiateLoginUri || !args.clientId) {
    return {
      verification_uri,
      verification_uri_complete: onAuthorizationServer,
    };
  }

  try {
    return {
      verification_uri,
      verification_uri_complete: buildInitiateLoginRedirectUrl(
        args.initiateLoginUri,
        {
          iss: args.issuer,
          target_link_uri: buildDeviceFlowTargetLinkUri({
            user_code: args.userCode,
            client_id: args.clientId,
            iss: args.issuer,
            login_hint: args.loginHint,
          }),
          login_hint: args.loginHint,
        },
      ),
    };
  } catch {
    return {
      verification_uri,
      verification_uri_complete: onAuthorizationServer,
    };
  }
}

/**
 * Extract `user_code` from a device `target_link_uri` (same shape as
 * `buildDeviceFlowTargetLinkUri`).
 */
export function userCodeFromDeviceTargetLinkUri(
  targetLinkUri: string,
): string | undefined {
  try {
    const raw = new URL(targetLinkUri).searchParams.get("user_code")?.trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}
