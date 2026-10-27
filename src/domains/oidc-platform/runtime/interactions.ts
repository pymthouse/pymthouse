import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { getProvider } from "./provider-instance";
import { authOptions } from "@/platform/auth/next-auth-options";
import { getIssuer } from "@/platform/oidc/issuer-urls";
import { buildProviderNodeRequest } from "./provider-bridge";

const DEBUG_OIDC_LOGS = process.env.OIDC_DEBUG_LOGS === "1";

export async function readOidcInteraction(
  request: NextRequest,
  uid: string,
): Promise<
  | {
      ok: true;
      body: {
        uid: string;
        prompt: unknown;
        params: unknown;
        session: unknown;
      };
    }
  | { ok: false; status: 404; body: Record<string, unknown> }
> {
  const provider = await getProvider();
  try {
    const { req, res } = buildProviderNodeRequest({
      method: "GET",
      request,
      path: `/interaction/${uid}`,
    });
    const details = await provider.interactionDetails(req, res);
    return {
      ok: true,
      body: {
        uid: details.uid,
        prompt: details.prompt,
        params: details.params,
        session: details.session,
      },
    };
  } catch (err) {
    if (DEBUG_OIDC_LOGS) {
      console.warn("[OIDC] interaction GET failed", { uid, err });
    }
    return {
      ok: false,
      status: 404,
      body: {
        error: "interaction_not_found",
        error_description: "Interaction session not found or expired",
      },
    };
  }
}

export async function completeOidcInteraction(params: {
  request: NextRequest;
  uid: string;
}): Promise<
  | { ok: true; redirectTo: string }
  | { ok: false; status: 401 | 500; body: Record<string, unknown> }
> {
  const provider = await getProvider();
  let body: { action?: "approve" | "deny" } = {};
  try {
    const contentType = params.request.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await params.request.formData();
      const action = formData.get("action");
      if (action === "approve" || action === "deny") {
        body = { action };
      }
    } else {
      body = await params.request.json();
    }
  } catch {
    // Allow login interactions without JSON.
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "unauthorized",
        error_description: "You must be signed in",
      },
    };
  }
  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "unauthorized",
        error_description: "Invalid session",
      },
    };
  }

  try {
    const { req, res } = buildProviderNodeRequest({
      method: "POST",
      request: params.request,
      path: `/interaction/${params.uid}`,
    });
    const details = await provider.interactionDetails(req, res);
    const { prompt } = details;

    let result: Record<string, unknown>;
    if (prompt.name === "login") {
      result = { login: { accountId: userId, remember: true } };
    } else if (prompt.name === "consent") {
      if (body.action === "deny") {
        result = {
          error: "access_denied",
          error_description: "User denied the authorization request",
        };
      } else {
        const grant = new provider.Grant();
        grant.clientId = details.params.client_id as string;
        grant.accountId = userId;
        const requestedScopes = details.params.scope as string;
        if (requestedScopes) {
          grant.addOIDCScope(requestedScopes);
          grant.addResourceScope(getIssuer(), requestedScopes);
        }
        await grant.save();
        result = { consent: { grantId: grant.jti } };
      }
    } else {
      result = {};
    }

    const redirectTo = await provider.interactionResult(req, res, result, {
      mergeWithLastSubmission: false,
    });
    return { ok: true, redirectTo };
  } catch (err) {
    if (DEBUG_OIDC_LOGS) {
      console.warn("[OIDC] interaction POST failed", { uid: params.uid, err });
    }
    return {
      ok: false,
      status: 500,
      body: {
        error: "interaction_failed",
        error_description: "Failed to process interaction",
      },
    };
  }
}
