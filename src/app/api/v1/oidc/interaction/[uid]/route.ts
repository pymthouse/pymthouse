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
import { asOidcAccountId, saveOidcConsentGrant } from "@/lib/oidc/consent-grant";
import {
  OIDC_MOUNT_PATH,
  getPublicOrigin,
} from "@/lib/oidc/issuer-urls";
import { getClient } from "@/lib/oidc/clients";
import {
  DCR_ALLOWED_SCOPES,
  filterScopesToAllowlist,
  isDcrClientId,
} from "@/lib/oidc/dcr-client";
import { bindMcpAppToGrant } from "@/lib/oidc/mcp-app-grant";
import { resolveOwnedAppChoice } from "@/lib/oidc/owned-apps";
import {
  getMcpResourceUrl,
  isMcpResourceIndicator,
  readResourceParam,
} from "@/lib/mcp/oauth-resource";

const DEBUG_OIDC_LOGS = process.env.OIDC_DEBUG_LOGS === "1";

function resolveMcpResource(
  resource: string | null,
  clientId: string,
): string | null {
  if (resource && isMcpResourceIndicator(resource)) {
    return getMcpResourceUrl();
  }
  if (isDcrClientId(clientId)) {
    return getMcpResourceUrl();
  }
  return null;
}

/**
 * Resolve the allowlist used for both consent display and grant issuance.
 * DCR clients are capped to MCP scopes; registered clients use DB allowedScopes.
 */
async function resolveConsentScopeAllowlist(
  clientId: string,
): Promise<readonly string[]> {
  if (isDcrClientId(clientId)) {
    return DCR_ALLOWED_SCOPES;
  }
  const registered = await getClient(clientId);
  return registered?.allowedScopes ?? [];
}

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
  let body: { action?: "approve" | "deny"; app_client_id?: string } = {};
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      const action = formData.get("action");
      if (action === "approve" || action === "deny") {
        body = { action };
      }
      const appClientId = formData.get("app_client_id");
      if (typeof appClientId === "string" && appClientId.trim()) {
        body.app_client_id = appClientId.trim();
      }
    } else {
      body = await request.json();
    }
  } catch {
    // Allow login interactions that do not provide a JSON body.
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json(
      { error: "unauthorized", error_description: "You must be signed in" },
      { status: 401 },
    );
  }

  const userId = asOidcAccountId((session.user as Record<string, unknown>).id);
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
        const clientId = details.params.client_id as string;
        const resource = readResourceParam(
          details.params as Record<string, unknown>,
        );
        const mcpResource = resolveMcpResource(resource, clientId);

        let mcpAppBinding: Awaited<ReturnType<typeof resolveOwnedAppChoice>> =
          null;
        if (mcpResource) {
          if (!body.app_client_id) {
            return NextResponse.json(
              {
                error: "invalid_request",
                error_description: "app_client_id is required for MCP consent",
              },
              { status: 400 },
            );
          }
          mcpAppBinding = await resolveOwnedAppChoice(userId, body.app_client_id);
          if (!mcpAppBinding) {
            return NextResponse.json(
              {
                error: "access_denied",
                error_description: "Selected app is not owned by this user",
              },
              { status: 403 },
            );
          }
        }

        // Grant only scopes the consent UI would show — never the raw request
        // string, or a malicious client can hide privileged scopes from the user.
        const scopeAllowlist = await resolveConsentScopeAllowlist(clientId);
        const grantedScopes = filterScopesToAllowlist(
          details.params.scope as string | undefined,
          scopeAllowlist,
        ).join(" ");
        let grantId: string | undefined;

        if (mcpResource) {
          const grant = new provider.Grant();
          grant.clientId = clientId;
          grant.accountId = userId;
          if (grantedScopes) {
            grant.addOIDCScope(grantedScopes);
            grant.addResourceScope(mcpResource, grantedScopes);
          }
          await grant.save();
          grantId = grant.jti;
          if (mcpAppBinding && grantId) {
            await bindMcpAppToGrant(grantId, {
              accountId: userId,
              publicClientId: mcpAppBinding.publicClientId,
              developerAppId: mcpAppBinding.developerAppId,
            });
          }
        } else {
          grantId = await saveOidcConsentGrant({
            provider,
            clientId,
            accountId: userId,
            scope: grantedScopes || undefined,
          });
        }

        if (!grantId) {
          return NextResponse.json(
            { error: "invalid_scope", error_description: "No scopes were requested" },
            { status: 400 },
          );
        }

        result = {
          consent: {
            grantId,
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
