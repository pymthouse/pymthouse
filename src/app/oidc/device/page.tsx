import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";
import DeviceVerifyForm from "./device-verify-form";
import { resolveHostContext } from "@/lib/oidc/host-resolution";
import { getInitiateLoginUriForDeviceFlow } from "@/lib/oidc/clients";
import { SqliteAdapter } from "@/lib/oidc/adapter";
import { normalizeUserCode } from "@/lib/oidc/device";
import { isDeviceCodeBound } from "@/lib/oidc/device-approval";
import {
  buildDeviceFlowTargetLinkUri,
  issuerMatchesExpected,
} from "@/lib/oidc/third-party-initiate-login";
import { thirdPartyInitiateSkipCookieName } from "@/lib/oidc/third-party-initiate-skip-cookie";
import { getIssuer } from "@/lib/oidc/issuer-urls";

type SearchParams = Record<string, string | string[] | undefined>;

type DeviceCodePageLookup = {
  clientId?: string;
  bound: boolean;
};

function clientIdFromDevicePayload(
  payload: Record<string, unknown>,
): string | undefined {
  if (typeof payload.clientId === "string") {
    return payload.clientId;
  }
  const params = payload.params;
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const clientId = (params as Record<string, unknown>).client_id;
  return typeof clientId === "string" ? clientId : undefined;
}

async function lookupDeviceCodeForPage(
  userCode: string | undefined,
  clientIdParam: string | undefined,
): Promise<DeviceCodePageLookup> {
  if (userCode) {
    try {
      const adapter = new SqliteAdapter("DeviceCode");
      const normalized = normalizeUserCode(userCode);
      const payload = await adapter.findByUserCode(normalized);
      if (payload) {
        const record = payload as Record<string, unknown>;
        return {
          clientId: clientIdFromDevicePayload(record) ?? clientIdParam,
          bound: isDeviceCodeBound(record),
        };
      }
    } catch {
      /* ignore */
    }
  }
  return { clientId: clientIdParam, bound: false };
}

function DeviceApprovedPanel({
  brandName,
}: {
  brandName: string;
}) {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-zinc-800 bg-zinc-900/60 rounded-2xl p-6 sm:p-8 shadow-2xl shadow-black/30">
        <div className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-300">
          Device Authorization
        </div>
        <h1 className="text-2xl font-semibold text-zinc-100 mt-3">
          Device approved
        </h1>
        <p className="text-sm text-zinc-400 mt-2">
          You can return to the app that started this sign-in. Polling will
          finish on its own.
        </p>
        <p className="text-xs text-zinc-600 text-center mt-6">
          Identity powered by{" "}
          <span className="text-zinc-500">{brandName}</span>
        </p>
      </div>
    </main>
  );
}

export default async function DeviceVerificationPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<SearchParams>;
}>) {
  const params = await searchParams;
  const session = await getServerSession(authOptions);
  const hostContext = await resolveHostContext();

  const userCode =
    typeof params.user_code === "string" ? params.user_code : undefined;
  const clientIdParam =
    typeof params.client_id === "string" ? params.client_id : undefined;
  const issParam = typeof params.iss === "string" ? params.iss : undefined;
  const loginHintParam =
    typeof params.login_hint === "string" ? params.login_hint : undefined;

  const expectedIssuer = getIssuer();
  const { clientId: authoritativeClientId, bound: deviceAlreadyBound } =
    await lookupDeviceCodeForPage(userCode, clientIdParam);

  // Bound DeviceCodes must never re-federate — this is the durable guard that
  // lets verification_uri_complete point at the RP directly (no skip cookie).
  if (deviceAlreadyBound) {
    return (
      <DeviceApprovedPanel brandName={hostContext.branding.displayName} />
    );
  }

  const skipCookieName = authoritativeClientId
    ? thirdPartyInitiateSkipCookieName(authoritativeClientId, userCode)
    : null;
  const skipThirdParty =
    skipCookieName !== null
      ? (await cookies()).get(skipCookieName)?.value === "1"
      : true;

  // Deliberately ahead of the session check. When an app federates device
  // approval, the approving subject must come from the RP; approving with a
  // local session here would bind the device code to a pymthouse account
  // instead of the app's end user. Skip cookie still covers hand-typed
  // verification_uri → initiate-login → RP return before approval.
  if (
    authoritativeClientId &&
    issParam &&
    issuerMatchesExpected(issParam, expectedIssuer) &&
    !skipThirdParty
  ) {
    const initiateLoginUri = await getInitiateLoginUriForDeviceFlow(
      authoritativeClientId,
    );
    if (initiateLoginUri) {
      const targetLinkUri = buildDeviceFlowTargetLinkUri({
        user_code: userCode,
        client_id: authoritativeClientId,
        iss: issParam,
        login_hint: loginHintParam,
      });
      redirect(
        `/oidc/device/initiate-login?${new URLSearchParams({
          client_id: authoritativeClientId,
          target_link_uri: targetLinkUri,
          ...(loginHintParam ? { login_hint: loginHintParam } : {}),
        }).toString()}`,
      );
    }
  }

  if (!session?.user) {
    const qs = new URLSearchParams();
    if (userCode) qs.set("user_code", userCode);
    if (authoritativeClientId) qs.set("client_id", authoritativeClientId);
    if (issParam) qs.set("iss", issParam);
    if (loginHintParam) qs.set("login_hint", loginHintParam);
    const devicePath = `/oidc/device${qs.toString() ? `?${qs.toString()}` : ""}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(devicePath)}`);
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-zinc-800 bg-zinc-900/60 rounded-2xl p-6 sm:p-8 shadow-2xl shadow-black/30">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-14 h-14 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-2xl flex items-center justify-center shrink-0">
            <svg
              className="w-7 h-7 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="inline-flex items-center rounded-full border border-violet-500/20 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-violet-300">
              Device Authorization
            </div>
            <h1 className="text-2xl font-semibold text-zinc-100 mt-3">
              Sign in on another device
            </h1>
            <p className="text-sm text-zinc-400 mt-2">
              Signed in as{" "}
              <span className="text-zinc-200">
                {session.user.name || session.user.email}
              </span>
            </p>
          </div>
        </div>

        <DeviceVerifyForm />

        <p className="text-xs text-zinc-600 text-center mt-6">
          Identity powered by{" "}
          <span className="text-zinc-500">
            {hostContext.branding.displayName}
          </span>
        </p>
      </div>
    </main>
  );
}
