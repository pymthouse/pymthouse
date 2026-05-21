import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { authOptions } from "@/platform/auth/next-auth-options";
import { getProvider } from "@/domains/oidc-platform/runtime/provider-instance";
import { getPublicOrigin } from "@/platform/oidc/issuer-urls";
import { resolveAppBrandingByClientId, shouldUseWhiteLabelBranding } from "@/domains/oidc-platform/runtime/branding";
import { resolveHostContext } from "@/domains/oidc-platform/runtime/host-context";
import { checkAppAccess } from "@/domains/oidc-platform/runtime/app-access";

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
  // Use the actual request path so the provider's cookie middleware can find the
  // _interaction cookie (set with path=/oidc/interaction when redirecting from authorize).
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
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const uid = asSingleValue(params.uid);

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

  const session = await getServerSession(authOptions);
  
  // Try to get interaction details early to extract client_id for branded login redirect
  let clientId: string | null = null;
  try {
    const requestHeaders = await headers();
    const preflightReq = buildNodeRequest("GET", uid, requestHeaders);
    const provider = await getProvider();
    const preflightDetails = await provider.interactionDetails(preflightReq.req, preflightReq.res);
    clientId = preflightDetails.params.client_id as string || null;
  } catch {
    // Interaction may be invalid/expired; we'll handle this after session check
  }

  if (!session?.user) {
    const loginUrl = new URL("/login", getPublicOrigin());
    loginUrl.searchParams.set("callbackUrl", `/oidc/interaction?uid=${uid}`);
    if (clientId) {
      loginUrl.searchParams.set("client_id", clientId);
    }
    redirect(loginUrl.pathname + loginUrl.search);
  }

  const requestHeaders = await headers();
  const { req, res } = buildNodeRequest("GET", uid, requestHeaders);

  try {
    const provider = await getProvider();
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

    if (details.prompt.name === "login") {
      // Complete login server-side in the same request that has the cookie.
      // A client-side POST to /api/v1/oidc/interaction/:uid would not receive the
      // _interaction cookie (path=/oidc/interaction) so we must do it here.
      const userId = (session.user as Record<string, unknown>).id as string;
      if (!userId) {
        return (
          <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
            <div className="max-w-md w-full border border-red-500/20 bg-zinc-900/40 rounded-xl p-6">
              <h1 className="text-lg font-semibold text-red-300 mb-2">Invalid Session</h1>
              <p className="text-sm text-zinc-400">Your session is invalid. Please sign in again.</p>
            </div>
          </main>
        );
      }

      const result = {
        login: {
          accountId: userId,
          remember: true,
        },
      };

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
