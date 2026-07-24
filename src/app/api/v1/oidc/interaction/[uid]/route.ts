/**
 * Interaction endpoint — called after login/consent to complete the OIDC flow.
 *
 * GET  /api/v1/oidc/interaction/:uid — return interaction details (for consent page)
 * POST /api/v1/oidc/interaction/:uid — submit interaction result (login or consent)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { getProvider } from "@/lib/oidc/provider";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  OIDC_MOUNT_PATH,
  getIssuer,
  getPublicOrigin,
} from "@/lib/oidc/issuer-urls";

const DEBUG_OIDC_LOGS = process.env.OIDC_DEBUG_LOGS === "1";

/**
 * Build a minimal Node.js IncomingMessage/ServerResponse pair for calling
 * node-oidc-provider's `interactionDetails` and `interactionResult` APIs.
 *
 * The POST request body is intentionally NOT forwarded here. Both provider
 * methods read state from the signed `_interaction` cookie (present in the
 * forwarded headers) and take the interaction result as an explicit JS
 * parameter — neither reads from the HTTP body. Omitting the body keeps
 * this bridge simple and avoids stream-lifecycle bugs.
 */
function buildNodeRequest(
  method: "GET" | "POST",
  uid: string,
  request: NextRequest,
): { req: IncomingMessage; res: ServerResponse } {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = `${OIDC_MOUNT_PATH}/interaction/${uid}`;
  request.headers.forEach((value, key) => {
    req.headers[key.toLowerCase()] = value;
  });
  const publicUrl = new URL(getPublicOrigin());
  req.headers.host = publicUrl.host;
  if (!req.headers["x-forwarded-proto"]) {
    req.headers["x-forwarded-proto"] = publicUrl.protocol.replace(":", "");
  }
  req.push(null);
  const res = new ServerResponse(req);
  return { req, res };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
): Promise<NextResponse> {
  const { uid } = await params;
  const provider = await getProvider();

  try {
    const { req, res } = buildNodeRequest("GET", uid, request);

    const details = await provider.interactionDetails(req, res);

    return NextResponse.json({
      uid: details.uid,
      prompt: details.prompt,
      params: details.params,
      session: details.session,
    });
  } catch (err) {
    if (DEBUG_OIDC_LOGS) {
      console.warn("[OIDC] interaction GET failed", { uid, err });
    }
    return NextResponse.json(
      { error: "interaction_not_found", error_description: "Interaction session not found or expired" },
      { status: 404 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
): Promise<NextResponse> {
  const { uid } = await params;
  const provider = await getProvider();
  let body: { action?: "approve" | "deny" } = {};
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      const action = formData.get("action");
      if (action === "approve" || action === "deny") {
        body = { action };
      }
    } else {
      body = await request.json();
    }
  } catch {
    // Allow login interactions that do not provide a JSON body.
  }

  // Require an authenticated NextAuth session for login/consent completion
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json(
      { error: "unauthorized", error_description: "You must be signed in" },
      { status: 401 },
    );
  }

  const userId = (session.user as Record<string, unknown>).id as string;
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", error_description: "Invalid session" },
      { status: 401 },
    );
  }

  try {
    const { req, res } = buildNodeRequest("POST", uid, request);

    const details = await provider.interactionDetails(req, res);
    const { prompt } = details;

    let result: Record<string, unknown>;

    if (prompt.name === "login") {
      result = {
        login: {
          accountId: userId,
          remember: true,
        },
      };
    } else if (prompt.name === "consent") {
      if (body.action === "deny") {
        result = {
          error: "access_denied",
          error_description: "User denied the authorization request",
        };
      } else {
        // Grant the requested scopes (OIDC + resource)
        const grant = new provider.Grant();
        grant.clientId = details.params.client_id as string;
        grant.accountId = userId;

        const requestedScopes = details.params.scope as string;
        if (requestedScopes) {
          grant.addOIDCScope(requestedScopes);
          grant.addResourceScope(getIssuer(), requestedScopes);
        }

        await grant.save();

        result = {
          consent: {
            grantId: grant.jti,
          },
        };
      }
    } else {
      result = {};
    }

    const redirectTo = await provider.interactionResult(req, res, result, {
      mergeWithLastSubmission: false,
    });

    return NextResponse.redirect(redirectTo, { status: 302 });
  } catch (err) {
    if (DEBUG_OIDC_LOGS) {
      console.warn("[OIDC] interaction POST failed", { uid, err });
    }
    return NextResponse.json(
      { error: "interaction_failed", error_description: "Failed to process interaction" },
      { status: 500 },
    );
  }
}
