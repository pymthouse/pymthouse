import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/next-auth-options";
import { getProvider } from "@/lib/oidc/provider";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { checkAppAccess } from "@/lib/oidc/app-access";

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

function InteractionMessage({
  title,
  body,
  borderClass,
  titleClass,
  children,
}: {
  title: string;
  body: ReactNode;
  borderClass: string;
  titleClass: string;
  children?: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className={`max-w-md w-full ${borderClass} bg-zinc-900/40 rounded-xl p-6`}>
        <h1 className={`text-lg font-semibold ${titleClass} mb-2`}>{title}</h1>
        <p className={`text-sm text-zinc-400${children ? " mb-4" : ""}`}>{body}</p>
        {children}
      </div>
    </main>
  );
}

function isNextRedirectError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "digest" in err &&
    String((err as { digest?: string }).digest).startsWith("NEXT_REDIRECT")
  );
}

async function peekClientIdFromInteraction(uid: string): Promise<string | null> {
  try {
    const requestHeaders = await headers();
    const preflightReq = buildNodeRequest("GET", uid, requestHeaders);
    const provider = await getProvider();
    const preflightDetails = await provider.interactionDetails(
      preflightReq.req,
      preflightReq.res,
    );
    return (preflightDetails.params.client_id as string) || null;
  } catch {
    // Interaction may be invalid/expired; we'll handle this after session check
    return null;
  }
}

async function renderAccessDeniedIfNeeded(
  requestedClientId: string | undefined,
  userId: string | undefined,
): Promise<ReactNode | null> {
  if (!requestedClientId) return null;

  const accessCheck = await checkAppAccess(requestedClientId, userId || null);
  if (accessCheck.allowed) return null;

  return (
    <InteractionMessage
      title={`${accessCheck.appName || "Application"} - Access Restricted`}
      body={accessCheck.reason}
      borderClass="border border-amber-500/20"
      titleClass="text-amber-300"
    >
      {accessCheck.appStatus && (
        <div className="px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-xs">
          <span className="text-zinc-500">Status:</span>{" "}
          <span className="text-zinc-300">{accessCheck.appStatus}</span>
        </div>
      )}
    </InteractionMessage>
  );
}

async function completeLoginInteraction(
  provider: Awaited<ReturnType<typeof getProvider>>,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string | undefined,
): Promise<ReactNode> {
  if (!userId) {
    return (
      <InteractionMessage
        title="Invalid Session"
        body="Your session is invalid. Please sign in again."
        borderClass="border border-red-500/20"
        titleClass="text-red-300"
      />
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

export default async function OidcInteractionPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const uid = asSingleValue(params.uid);

  if (!uid) {
    return (
      <InteractionMessage
        title="Invalid Authorization Request"
        body="Missing interaction ID. Please restart authorization from the client application."
        borderClass="border border-red-500/20"
        titleClass="text-red-300"
      />
    );
  }

  const session = await getServerSession(authOptions);
  const clientId = await peekClientIdFromInteraction(uid);

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

    const userId = (session?.user as Record<string, unknown> | undefined)?.id as
      | string
      | undefined;
    const requestedClientId = details.params.client_id as string;

    const accessDenied = await renderAccessDeniedIfNeeded(
      requestedClientId,
      userId,
    );
    if (accessDenied) return accessDenied;

    if (details.prompt.name === "login") {
      // Complete login server-side in the same request that has the cookie.
      // A client-side POST to /api/v1/oidc/interaction/:uid would not receive the
      // _interaction cookie (path=/oidc/interaction) so we must do it here.
      return completeLoginInteraction(
        provider,
        req,
        res,
        (session.user as Record<string, unknown>).id as string,
      );
    }

    if (details.prompt.name === "consent") {
      redirect(`/oidc/consent?uid=${uid}`);
    }

    return (
      <InteractionMessage
        title="Unsupported Interaction"
        body={
          <>
            Prompt <span className="text-zinc-200">{details.prompt.name}</span> is
            not handled by this page.
          </>
        }
        borderClass="border border-zinc-800"
        titleClass="text-zinc-100"
      />
    );
  } catch (err) {
    // interactionResult can throw if something fails; redirect() also throws
    if (isNextRedirectError(err)) {
      throw err;
    }
    return (
      <InteractionMessage
        title="Expired or Invalid Request"
        body="This authorization request has expired. Please return to the application and try again."
        borderClass="border border-red-500/20"
        titleClass="text-red-300"
      />
    );
  }
}
