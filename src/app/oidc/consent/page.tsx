import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { authOptions } from "@/platform/auth/next-auth-options";
import { getClient } from "@/domains/oidc-platform/runtime/clients";
import { getScopeDefinition } from "@/platform/oidc/scopes";
import { getProvider } from "@/domains/oidc-platform/runtime/provider-instance";
import { OIDC_MOUNT_PATH, getPublicOrigin } from "@/platform/oidc/issuer-urls";
import { resolveAppBrandingByClientId, getDefaultBranding, shouldUseWhiteLabelBranding } from "@/domains/oidc-platform/runtime/branding";
import { resolveHostContext } from "@/domains/oidc-platform/runtime/host-context";
import { getConsentDisplayData } from "@/domains/oidc-platform/runtime/consent-page";
import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import ConsentForm from "./consent-form";

type SearchParams = Record<string, string | string[] | undefined>;

function asSingleValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function getHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function getExternalHref(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.includes("@") && !value.startsWith("mailto:")) {
    return `mailto:${value}`;
  }

  return value;
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const uid = asSingleValue(params.uid);

  if (!uid) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
          <h1 className="text-lg font-semibold text-red-300 mb-2">
            Invalid Authorization Request
          </h1>
          <p className="text-sm text-zinc-400">
            Missing interaction ID. Please start the authorization flow from the client application.
          </p>
        </div>
      </main>
    );
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/oidc/consent?uid=${uid}`)}`);
  }

  // Fetch interaction details from the provider
  let interactionDetails: {
    prompt: { name: string; details: Record<string, unknown> };
    params: Record<string, unknown>;
    session?: { accountId?: string };
  };

  try {
    const provider = await getProvider();
    const requestHeaders = await headers();
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = "GET";
    req.url = `${OIDC_MOUNT_PATH}/interaction/${uid}`;
    requestHeaders.forEach((value, key) => {
      req.headers[key.toLowerCase()] = value;
    });
    const publicUrl = new URL(getPublicOrigin());
    req.headers.host = requestHeaders.get("x-forwarded-host") || publicUrl.host;
    if (!req.headers["x-forwarded-proto"]) {
      req.headers["x-forwarded-proto"] = publicUrl.protocol.replace(":", "");
    }
    req.push(null);
    const res = new ServerResponse(req);

    interactionDetails = await provider.interactionDetails(req, res);
  } catch {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
          <h1 className="text-lg font-semibold text-red-300 mb-2">
            Expired or Invalid Request
          </h1>
          <p className="text-sm text-zinc-400">
            This authorization request has expired. Please return to the application and try again.
          </p>
        </div>
      </main>
    );
  }

  const clientId = interactionDetails.params.client_id as string;
  const redirectUri = interactionDetails.params.redirect_uri as string;
  const scope = interactionDetails.params.scope as string;

  const client = await getClient(clientId);
  if (!client) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
          <h1 className="text-lg font-semibold text-red-300 mb-2">
            Unknown Application
          </h1>
          <p className="text-sm text-zinc-400">
            The requesting application is not registered.
          </p>
        </div>
      </main>
    );
  }

  const branding = await resolveAppBrandingByClientId(clientId);
  const isWhiteLabel = shouldUseWhiteLabelBranding(branding);
  const { developerApp, logoUrl } = await getConsentDisplayData({
    clientId,
    oidcClientRowId: client.id,
    branding,
  });

  const scopes = scope
    ? scope.split(/\s+/).filter((s) => client.allowedScopes.includes(s))
    : [];
  const scopeItems = scopes.map((s) => ({
    name: s,
    label: getScopeDefinition(s)?.label || s,
    description:
      getScopeDefinition(s)?.description ||
      "Access information associated with this permission",
    required: getScopeDefinition(s)?.required || false,
  }));
  const signedInAs = session.user.name || session.user.email || "Your account";
  const redirectHost = getHostLabel(redirectUri || "");
  const websiteHost = developerApp?.websiteUrl
    ? getHostLabel(developerApp.websiteUrl)
    : null;

  const primaryColorStyle = { backgroundColor: branding.primaryColor };
  const primaryBorderStyle = { borderColor: `${branding.primaryColor}33` };
  const primaryBgStyle = { backgroundColor: `${branding.primaryColor}1a` };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="max-w-2xl w-full border border-zinc-800 bg-zinc-900/60 rounded-2xl p-6 sm:p-8 shadow-2xl shadow-black/30">
        <div className="flex items-start gap-4 mb-6">
          {logoUrl ? (
            // Tenant logo URLs are dynamic, so next/image remote host config cannot enumerate them.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={client.displayName}
              className="w-14 h-14 rounded-2xl object-cover shrink-0 border border-zinc-700"
            />
          ) : (
            <div 
              className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
              style={primaryColorStyle}
            >
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
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
            </div>
          )}
          <div className="min-w-0">
            <div 
              className="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em]"
              style={{ 
                borderColor: `${branding.primaryColor}33`,
                backgroundColor: `${branding.primaryColor}1a`,
                color: branding.primaryColor,
              }}
            >
              Permission Request
            </div>
            <h1 className="text-2xl font-semibold text-zinc-100 mt-3">
              {isWhiteLabel 
                ? `Sign in to ${branding.displayName}`
                : `Review access for ${client.displayName}`}
            </h1>
            <p className="text-sm text-zinc-400 mt-2 max-w-xl">
              {isWhiteLabel 
                ? `${client.displayName} is requesting access to your account.`
                : `Approve this only if you trust this application and expect to return to `}
              {!isWhiteLabel && <span className="text-zinc-200">{redirectHost}</span>}
              {!isWhiteLabel && "."}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 mb-6">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
              Application
            </p>
            <p className="text-sm font-medium text-zinc-100 mt-2">
              {developerApp?.name || client.displayName}
            </p>
            <p className="text-sm text-zinc-400 mt-1">
              {developerApp?.developerName
                ? `Built by ${developerApp.developerName}`
                : "Registered application"}
            </p>
            {websiteHost && (
              <p className="text-xs text-zinc-500 mt-2">
                Website: <span className="text-zinc-300">{websiteHost}</span>
              </p>
            )}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
              Signed In As
            </p>
            <p className="text-sm font-medium text-zinc-100 mt-2">{signedInAs}</p>
            {session.user.email && (
              <p className="text-sm text-zinc-400 mt-1">{session.user.email}</p>
            )}
            <p className="text-xs text-zinc-500 mt-2">
              You can deny this request if this is not the account you want to use.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 mb-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                Requested Access
              </h2>
              <p className="text-xs text-zinc-500 mt-1">
                Only the permissions listed below will be shared with this app.
              </p>
            </div>
            <div className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-400">
              {scopeItems.length} permission{scopeItems.length === 1 ? "" : "s"}
            </div>
          </div>
          <ul className="space-y-3">
            {scopeItems.map((item) => (
              <li
                key={item.name}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
              >
                <div className="flex items-start gap-3">
                  <div 
                    className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                    style={{
                      backgroundColor: `${branding.primaryColor}1a`,
                      borderWidth: 1,
                      borderColor: `${branding.primaryColor}33`,
                    }}
                  >
                    <svg
                      className="w-4 h-4"
                      style={{ color: branding.primaryColor }}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-zinc-100">
                      {item.label}
                      {item.required && (
                        <span className="ml-2 text-xs font-normal text-zinc-500">
                          Required
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-zinc-400 mt-1">
                      {item.description}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 mb-6">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
            After You Continue
          </p>
          <p className="text-sm text-zinc-300 mt-2">
            You will be sent back to{" "}
            <span className="text-zinc-100">{redirectHost}</span> to finish sign-in.
          </p>
          {redirectUri && (
            <p className="text-xs text-zinc-500 mt-2 break-all">{redirectUri}</p>
          )}
        </div>

        {(developerApp?.websiteUrl ||
          developerApp?.privacyPolicyUrl ||
          developerApp?.supportUrl) && (
          <div className="flex flex-wrap gap-4 text-xs text-zinc-400 mb-6">
            {developerApp?.websiteUrl && (
              <a
                href={getExternalHref(developerApp.websiteUrl)}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zinc-200 transition-colors"
              >
                Website
              </a>
            )}
            {developerApp?.privacyPolicyUrl && (
              <a
                href={getExternalHref(developerApp.privacyPolicyUrl)}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zinc-200 transition-colors"
              >
                Privacy Policy
              </a>
            )}
            {developerApp?.supportUrl && (
              <a
                href={getExternalHref(developerApp.supportUrl)}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zinc-200 transition-colors"
              >
                Support
              </a>
            )}
          </div>
        )}

        <ConsentForm uid={uid} branding={branding} />

        <p className="text-xs text-zinc-500 text-center mt-4">
          By authorizing, you let {client.displayName} access only the permissions
          listed above.
        </p>

        {isWhiteLabel && (
          <p className="text-xs text-zinc-600 text-center mt-3">
            Identity powered by{" "}
            <span className="text-zinc-500">
              <span className="text-emerald-500">pymt</span>house
            </span>
          </p>
        )}
      </div>
    </main>
  );
}
