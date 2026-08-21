import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { getClient } from "@/lib/oidc/clients";
import { DCR_ALLOWED_SCOPES, isDcrClientId } from "@/lib/oidc/dcr-client";
import { getScopeDefinition } from "@/lib/oidc/scopes";
import {
  loadOidcInteractionDetails,
  type OidcInteractionDetails,
} from "@/lib/oidc/interaction-bridge";
import { oidcLoginRedirect } from "@/lib/oidc/customer-service-id";
import { resolveAppBrandingByClientId, shouldUseWhiteLabelBranding } from "@/lib/oidc/branding";
import { getDefaultBranding } from "@/lib/oidc/branding-shared";
import type { AppBranding } from "@/lib/oidc/branding-shared";
import { eq } from "drizzle-orm";
import type { ReactNode } from "react";
import ConsentForm from "./consent-form";
import {
  isTrustedOidcWarmRequest,
  warmOidcProvider,
} from "@/lib/oidc/warm";

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

function ConsentErrorPanel({
  title,
  children,
}: Readonly<{
  title: string;
  children: ReactNode;
}>) {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
        <h1 className="text-lg font-semibold text-red-300 mb-2">{title}</h1>
        <p className="text-sm text-zinc-400">{children}</p>
      </div>
    </main>
  );
}

type InteractionDetails = OidcInteractionDetails;

type ConsentClient = {
  id: string;
  clientId: string;
  displayName: string;
  redirectUris: string[];
  allowedScopes: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  clientSecretHash: string | null;
  createdAt: string;
};

async function resolveConsentClient(
  clientId: string,
  registeredClient: Awaited<ReturnType<typeof getClient>>,
  clientName?: string,
): Promise<ConsentClient | null> {
  if (registeredClient) {
    return registeredClient;
  }

  if (!isDcrClientId(clientId)) {
    return null;
  }

  return {
    id: clientId,
    clientId,
    displayName: clientName?.trim() || "MCP Connector",
    redirectUris: [],
    allowedScopes: [...DCR_ALLOWED_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: "none",
    clientSecretHash: null,
    createdAt: "",
  };
}

type DeveloperAppMeta = {
  name: string | null;
  developerName: string | null;
  websiteUrl: string | null;
  privacyPolicyUrl: string | null;
  supportUrl: string | null;
  logoLightUrl: string | null;
};

async function loadDeveloperAppMeta(
  registeredClientId: string | null,
  oidcClientId: string,
): Promise<{
  developerApp: DeveloperAppMeta | undefined;
  oidcLogoUri: string | null | undefined;
}> {
  if (!registeredClientId) {
    return { developerApp: undefined, oidcLogoUri: undefined };
  }

  const [developerAppRows, oidcClientRows] = await Promise.all([
    db
      .select({
        name: developerApps.name,
        developerName: developerApps.developerName,
        websiteUrl: developerApps.websiteUrl,
        privacyPolicyUrl: developerApps.privacyPolicyUrl,
        supportUrl: developerApps.supportUrl,
        logoLightUrl: developerApps.logoLightUrl,
      })
      .from(developerApps)
      .where(eq(developerApps.oidcClientId, registeredClientId))
      .limit(1),
    db
      .select({ logoUri: oidcClients.logoUri })
      .from(oidcClients)
      .where(eq(oidcClients.clientId, oidcClientId))
      .limit(1),
  ]);

  return {
    developerApp: developerAppRows[0],
    oidcLogoUri: oidcClientRows[0]?.logoUri,
  };
}

function resolveLogoUrl(input: {
  isWhiteLabel: boolean;
  brandingLogoUrl: string | null | undefined;
  oidcLogoUri: string | null | undefined;
  developerLogoUrl: string | null | undefined;
}): string | null {
  const fallback = input.oidcLogoUri || input.developerLogoUrl || null;
  if (input.isWhiteLabel) {
    return input.brandingLogoUrl || fallback;
  }
  return fallback;
}

function buildScopeItems(
  scope: string | undefined,
  allowedScopes: string[],
): Array<{
  name: string;
  label: string;
  description: string;
  required: boolean;
}> {
  const scopes = scope
    ? scope.split(/\s+/).filter((s) => allowedScopes.includes(s))
    : [];
  return scopes.map((s) => ({
    name: s,
    label: getScopeDefinition(s)?.label || s,
    description:
      getScopeDefinition(s)?.description ||
      "Access information associated with this permission",
    required: getScopeDefinition(s)?.required || false,
  }));
}

type ConsentViewModel = {
  uid: string;
  client: ConsentClient;
  branding: AppBranding;
  isWhiteLabel: boolean;
  developerApp: DeveloperAppMeta | undefined;
  logoUrl: string | null;
  scopeItems: Array<{
    name: string;
    label: string;
    description: string;
    required: boolean;
  }>;
  signedInAs: string;
  userEmail: string | null | undefined;
  redirectUri: string;
  redirectHost: string;
  websiteHost: string | null;
  heading: string;
  whiteLabelDescription: string | null;
  applicationSubtitle: string;
  permissionCountLabel: string;
};

async function buildConsentViewModel(
  uid: string,
  user: NonNullable<Session["user"]>,
  interactionDetails: InteractionDetails,
): Promise<ConsentViewModel | null> {
  const clientId = interactionDetails.params.client_id as string;
  const redirectUri = interactionDetails.params.redirect_uri as string;
  const scope = interactionDetails.params.scope as string;

  const registeredClient = await getClient(clientId);
  const client = await resolveConsentClient(
    clientId,
    registeredClient,
    interactionDetails.clientName,
  );
  if (!client) {
    return null;
  }

  const branding = registeredClient
    ? await resolveAppBrandingByClientId(clientId)
    : {
        ...getDefaultBranding(),
        displayName: client.displayName,
        appName: client.displayName,
      };
  const isWhiteLabel = registeredClient
    ? shouldUseWhiteLabelBranding(branding)
    : false;

  const { developerApp, oidcLogoUri } = await loadDeveloperAppMeta(
    registeredClient?.id ?? null,
    clientId,
  );
  const logoUrl = resolveLogoUrl({
    isWhiteLabel,
    brandingLogoUrl: branding.logoUrl,
    oidcLogoUri,
    developerLogoUrl: developerApp?.logoLightUrl,
  });

  const scopeItems = buildScopeItems(scope, client.allowedScopes);
  const signedInAs = user.name || user.email || "Your account";
  const redirectHost = getHostLabel(redirectUri || "");
  const websiteHost = developerApp?.websiteUrl
    ? getHostLabel(developerApp.websiteUrl)
    : null;

  const heading = isWhiteLabel
    ? `Sign in to ${branding.displayName}`
    : `Review access for ${client.displayName}`;
  const whiteLabelDescription = isWhiteLabel
    ? `${client.displayName} is requesting access to your account.`
    : null;
  const applicationSubtitle = developerApp?.developerName
    ? `Built by ${developerApp.developerName}`
    : "Registered application";
  const permissionCountLabel = `${scopeItems.length} permission${
    scopeItems.length === 1 ? "" : "s"
  }`;

  return {
    uid,
    client,
    branding,
    isWhiteLabel,
    developerApp,
    logoUrl,
    scopeItems,
    signedInAs,
    userEmail: user.email,
    redirectUri,
    redirectHost,
    websiteHost,
    heading,
    whiteLabelDescription,
    applicationSubtitle,
    permissionCountLabel,
  };
}

function ConsentAuthorizedView({
  model,
}: Readonly<{
  model: ConsentViewModel;
}>) {
  const {
    uid,
    client,
    branding,
    isWhiteLabel,
    developerApp,
    logoUrl,
    scopeItems,
    signedInAs,
    userEmail,
    redirectUri,
    redirectHost,
    websiteHost,
    heading,
    whiteLabelDescription,
    applicationSubtitle,
    permissionCountLabel,
  } = model;
  const primaryColorStyle = { backgroundColor: branding.primaryColor };
  const hasPolicyLinks = Boolean(
    developerApp?.websiteUrl ||
      developerApp?.privacyPolicyUrl ||
      developerApp?.supportUrl,
  );

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
              {heading}
            </h1>
            <p className="text-sm text-zinc-400 mt-2 max-w-xl">
              {whiteLabelDescription ?? (
                <>
                  Approve this only if you trust this application and expect to
                  return to <span className="text-zinc-200">{redirectHost}</span>.
                </>
              )}
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
            <p className="text-sm text-zinc-400 mt-1">{applicationSubtitle}</p>
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
            {userEmail && (
              <p className="text-sm text-zinc-400 mt-1">{userEmail}</p>
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
              {permissionCountLabel}
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

        {hasPolicyLinks && (
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

        <ConsentForm
          uid={uid}
          branding={branding}
        />

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

export default async function ConsentPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<SearchParams>;
}>) {
  const params = await searchParams;

  if (asSingleValue(params.warm) === "1") {
    const requestHeaders = await headers();
    if (!isTrustedOidcWarmRequest(requestHeaders)) {
      return (
        <ConsentErrorPanel title="Unauthorized">
          Warm requests require the Vercel cron header or CRON_SECRET.
        </ConsentErrorPanel>
      );
    }
    await warmOidcProvider();
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <p className="text-sm text-zinc-400">OIDC consent warmed</p>
      </main>
    );
  }

  const uid = asSingleValue(params.uid);

  if (!uid) {
    return (
      <ConsentErrorPanel title="Invalid Authorization Request">
        Missing interaction ID. Please start the authorization flow from the client
        application.
      </ConsentErrorPanel>
    );
  }

  const session = await getServerSession(authOptions);
  const interactionDetails = await loadOidcInteractionDetails(uid);
  if (!interactionDetails) {
    return (
      <ConsentErrorPanel title="Expired or Invalid Request">
        This authorization request has expired. Please return to the application and
        try again.
      </ConsentErrorPanel>
    );
  }

  const clientId = interactionDetails.params.client_id as string;
  if (!session?.user) {
    redirect(oidcLoginRedirect(clientId, `/oidc/consent?uid=${uid}`));
  }

  const model = await buildConsentViewModel(
    uid,
    session.user,
    interactionDetails,
  );
  if (!model) {
    return (
      <ConsentErrorPanel title="Unknown Application">
        The requesting application is not registered.
      </ConsentErrorPanel>
    );
  }

  return <ConsentAuthorizedView model={model} />;
}
