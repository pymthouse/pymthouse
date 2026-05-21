import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authOptions } from "@/platform/auth/next-auth-options";
import DeviceVerifyForm from "./device-verify-form";
import { resolveHostContext } from "@/domains/oidc-platform/runtime/host-context";
import { getInitiateLoginUriForDeviceFlow } from "@/domains/oidc-platform/runtime/clients";
import { SqliteAdapter } from "@/domains/oidc-platform/runtime/adapter";
import { normalizeUserCode } from "@/platform/oidc/device";
import {
  buildDeviceFlowTargetLinkUri,
  issuerMatchesExpected,
  thirdPartyInitiateSkipCookieName,
} from "@/platform/oidc/third-party-initiate-login";
import { getIssuer } from "@/platform/oidc/issuer-urls";

type SearchParams = Record<string, string | string[] | undefined>;

async function resolveAuthoritativeClientId(
  userCode: string | undefined,
  clientIdParam: string | undefined,
): Promise<string | undefined> {
  if (userCode) {
    try {
      const adapter = new SqliteAdapter("DeviceCode");
      const normalized = normalizeUserCode(userCode);
      const payload = await adapter.findByUserCode(normalized);
      if (payload) {
        const bound =
          typeof payload.clientId === "string"
            ? payload.clientId
            : typeof payload.params === "object" &&
                payload.params !== null &&
                typeof (payload.params as Record<string, unknown>).client_id === "string"
              ? ((payload.params as Record<string, unknown>).client_id as string)
              : undefined;
        if (bound) {
          return bound;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return clientIdParam;
}

export default async function DeviceVerificationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
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
  const authoritativeClientId = await resolveAuthoritativeClientId(
    userCode,
    clientIdParam,
  );

  if (!session?.user) {
    const skipCookieName = authoritativeClientId
      ? thirdPartyInitiateSkipCookieName(authoritativeClientId, userCode)
      : null;
    const skipThirdParty =
      skipCookieName !== null
        ? (await cookies()).get(skipCookieName)?.value === "1"
        : true;

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
