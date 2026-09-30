import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { authOptions } from "@/lib/next-auth-options";
import { getProvider } from "@/lib/oidc/provider";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { checkAppAccess } from "@/lib/oidc/app-access";
import {
  isCustomerServiceOidcClient,
  oidcInteractionPath,
  oidcLoginRedirect,
} from "@/lib/oidc/customer-service-id";
import { asOidcAccountId, saveOidcConsentGrant } from "@/lib/oidc/consent-grant";

type SearchParams = Record<string, string | string[] | undefined>;

function asSingleValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function buildNodeRequest(
  method: "GET" | "POST",
  uid: string,
  requestHeaders: Headers,
): { req: IncomingMessage; res: ServerResponse } {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  // Use the interaction page path so cookie middleware can find `_interaction`.
  req.url = `/oidc/interaction?uid=${uid}`;
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
  return { req, res };
}

export default async function OidcInteractionPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<SearchParams>;
}>) {
  const params = await searchParams;
  const uid = asSingleValue(params.uid);
  const clientIdFromQuery = asSingleValue(params.client_id);

  if (!uid) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
          <h1 className="text-lg font-semibold text-red-300 mb-2">Invalid Authorization Request</h1>
          <p className="text-sm text-zinc-400">
            Missing interaction ID. Please restart authorization from the client application.
          </p>
        </div>
      </main>
    );
  }

  const [session, provider, requestHeaders] = await Promise.all([
    getServerSession(authOptions),
    getProvider(),
    headers(),
  ]);

  if (!session?.user) {
    // Prefer the cookie-backed interaction, then the query stamp from authorize.
    let clientId: string | null = clientIdFromQuery;
    try {
      const preflightReq = buildNodeRequest("GET", uid, requestHeaders);
      const preflightDetails = await provider.interactionDetails(
        preflightReq.req,
        preflightReq.res,
      );
      clientId =
        (preflightDetails.params.client_id as string | undefined)?.trim() ||
        clientIdFromQuery;
    } catch {
      // Interaction may be invalid/expired; the login hop can still proceed.
    }
    redirect(oidcLoginRedirect(clientId, oidcInteractionPath(uid, clientId)));
  }

  const { req, res } = buildNodeRequest("GET", uid, requestHeaders);

  try {
    const details = await provider.interactionDetails(req, res);

    // Check app access before allowing authentication
    const userId = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined;
    const requestedClientId = details.params.client_id as string;
    
    if (requestedClientId) {
      const accessCheck = await checkAppAccess(requestedClientId, userId || null);
      
      if (!accessCheck.allowed) {
        return (
          <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
            <div className="max-w-md w-full border border-amber-500/20 bg-zinc-900/40 rounded-xl p-6">
              <h1 className="text-lg font-semibold text-amber-300 mb-2">
                {accessCheck.appName || "Application"} - Access Restricted
              </h1>
              <p className="text-sm text-zinc-400 mb-4">
                {accessCheck.reason}
              </p>
              {accessCheck.appStatus && (
                <div className="px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-xs">
                  <span className="text-zinc-500">Status:</span>{" "}
                  <span className="text-zinc-300">{accessCheck.appStatus}</span>
                </div>
              )}
            </div>
          </main>
        );
      }
    }

    if (details.prompt.name === "login" || (
      details.prompt.name === "consent" &&
      isCustomerServiceOidcClient(requestedClientId)
    )) {
      // Complete login server-side in the same request that has the cookie.
      // A client-side POST to /api/v1/oidc/interaction/:uid would not receive the
      // _interaction cookie (path=/oidc/interaction) so we must do it here.
      const accountId = asOidcAccountId(
        (session.user as Record<string, unknown>).id,
      );
      if (!accountId) {
        return (
          <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
            <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
              <h1 className="text-lg font-semibold text-red-300 mb-2">Invalid Session</h1>
              <p className="text-sm text-zinc-400">Your session is invalid. Please sign in again.</p>
            </div>
          </main>
        );
      }

      const result: {
        login?: { accountId: string; remember: boolean };
        consent?: { grantId: string };
      } = {};
      if (details.prompt.name === "login") {
        result.login = {
          accountId,
          remember: true,
        };
      }

      // First-party CS RP: skip the consent UI. Submitting login+consent together
      // also avoids loadExistingGrant reading a missing session (generic throw → oops).
      if (isCustomerServiceOidcClient(requestedClientId)) {
        const grantId = await saveOidcConsentGrant({
          provider,
          clientId: requestedClientId,
          accountId,
          scope: details.params.scope as string | undefined,
        });
        if (grantId) {
          result.consent = { grantId };
        }
      }

      const redirectTo = await provider.interactionResult(req, res, result, {
        mergeWithLastSubmission: false,
      });

      redirect(redirectTo);
    }

    if (details.prompt.name === "consent") {
      redirect(`/oidc/consent?uid=${uid}`);
    }

    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-zinc-800 bg-zinc-900/40 rounded-xl p-6">
          <h1 className="text-lg font-semibold text-zinc-100 mb-2">Unsupported Interaction</h1>
          <p className="text-sm text-zinc-400">
            Prompt <span className="text-zinc-200">{details.prompt.name}</span> is not handled by this
            page.
          </p>
        </div>
      </main>
    );
  } catch (err) {
    // interactionResult can throw if something fails; redirect() also throws
    if (err && typeof err === "object" && "digest" in err && String((err as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) {
      throw err;
    }
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
          <h1 className="text-lg font-semibold text-red-300 mb-2">Expired or Invalid Request</h1>
          <p className="text-sm text-zinc-400">
            This authorization request has expired. Please return to the application and try again.
          </p>
        </div>
      </main>
    );
  }
}
