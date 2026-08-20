/**
 * Login/consent interaction for node-oidc-provider.
 *
 * Served from `/api/v1/oidc/[...oidc]` so provider init stays on one lambda.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Provider } from "oidc-provider";

import { getClient } from "@/lib/oidc/clients";
import { asOidcAccountId, saveOidcConsentGrant } from "@/lib/oidc/consent-grant";
import { isCustomerServiceOidcClient } from "@/lib/oidc/customer-service-id";
import {
  DCR_ALLOWED_SCOPES,
  filterScopesToAllowlist,
  isDcrClientId,
} from "@/lib/oidc/dcr-client";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { bindMcpAppToGrant } from "@/lib/oidc/mcp-app-grant";
import { resolveOwnedAppChoice } from "@/lib/oidc/owned-apps";
import { getProvider } from "@/lib/oidc/provider";
import {
  getMcpResourceUrl,
  isMcpResourceIndicator,
  readResourceParam,
} from "@/lib/mcp/oauth-resource";
import { authOptions } from "@/lib/next-auth-options";

const DEBUG_OIDC_LOGS = process.env.OIDC_DEBUG_LOGS === "1";

export function parseOidcInteractionUid(path: string): string | null {
  const match = /^\/interaction\/([^/]+)$/.exec(path);
  return match?.[1] ?? null;
}

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

async function resolveConsentScopeAllowlist(
  clientId: string,
): Promise<readonly string[]> {
  if (isDcrClientId(clientId)) {
    return DCR_ALLOWED_SCOPES;
  }
  const registered = await getClient(clientId);
  return registered?.allowedScopes ?? [];
}

type CookieCapableProvider = Provider & {
  cookieName: (type: string) => string;
  createContext: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    cookies: {
      set: (
        name: string,
        value: string | null,
        opts?: Record<string, unknown>,
      ) => void;
    };
  };
};

function appendSetCookies(from: ServerResponse, to: NextResponse): void {
  const raw = from.getHeader("set-cookie");
  if (!raw) return;
  const cookies = Array.isArray(raw) ? raw : [raw];
  for (const cookie of cookies) {
    to.headers.append("Set-Cookie", String(cookie));
  }
}

function attachHandshakeCookies(
  provider: Provider,
  uid: string,
  returnTo: string,
  ttlSeconds: number,
  response: NextResponse,
): void {
  const cookieProvider = provider as CookieCapableProvider;
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  const publicUrl = new URL(getPublicOrigin());
  req.headers.host = publicUrl.host;
  const res = new ServerResponse(req);
  const ctx = cookieProvider.createContext(req, res);
  const maxAge = Math.max(1, ttlSeconds) * 1000;
  ctx.cookies.set(cookieProvider.cookieName("interaction"), uid, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge,
  });
  ctx.cookies.set(cookieProvider.cookieName("resume"), uid, {
    path: new URL(returnTo, getPublicOrigin()).pathname,
    domain: undefined,
    httpOnly: true,
    sameSite: "lax",
    maxAge,
  });
  appendSetCookies(res, response);
}

async function buildConsentResult(opts: {
  provider: Provider;
  clientId: string;
  accountId: string;
  scope: string | undefined;
  params: Record<string, unknown>;
  appClientId?: string;
}): Promise<Record<string, unknown> | NextResponse> {
  const resource = readResourceParam(opts.params);
  const mcpResource = resolveMcpResource(resource, opts.clientId);

  let mcpAppBinding: Awaited<ReturnType<typeof resolveOwnedAppChoice>> = null;
  if (mcpResource) {
    if (!opts.appClientId) {
      return NextResponse.json(
        {
          error: "invalid_request",
          error_description: "app_client_id is required for MCP consent",
        },
        { status: 400 },
      );
    }
    mcpAppBinding = await resolveOwnedAppChoice(opts.accountId, opts.appClientId);
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

  const scopeAllowlist = await resolveConsentScopeAllowlist(opts.clientId);
  const grantedScopes = filterScopesToAllowlist(
    opts.scope,
    scopeAllowlist,
  ).join(" ");
  let grantId: string | undefined;

  if (mcpResource) {
    const grant = new opts.provider.Grant();
    grant.clientId = opts.clientId;
    grant.accountId = opts.accountId;
    if (grantedScopes) {
      grant.addOIDCScope(grantedScopes);
      grant.addResourceScope(mcpResource, grantedScopes);
    }
    await grant.save();
    grantId = grant.jti;
    if (mcpAppBinding && grantId) {
      await bindMcpAppToGrant(grantId, {
        accountId: opts.accountId,
        publicClientId: mcpAppBinding.publicClientId,
        developerAppId: mcpAppBinding.developerAppId,
      });
    }
  } else {
    grantId = await saveOidcConsentGrant({
      provider: opts.provider,
      clientId: opts.clientId,
      accountId: opts.accountId,
      scope: grantedScopes || undefined,
    });
  }

  if (!grantId) {
    return NextResponse.json(
      { error: "invalid_scope", error_description: "No scopes were requested" },
      { status: 400 },
    );
  }

  return {
    consent: {
      grantId,
    },
  };
}

async function interactionSubmissionResult(opts: {
  provider: Provider;
  promptName: string;
  clientId: string | undefined;
  scope: string | undefined;
  params: Record<string, unknown>;
  accountId: string;
  action?: "approve" | "deny";
  appClientId?: string;
}): Promise<Record<string, unknown> | NextResponse> {
  if (opts.promptName === "login") {
    const result: Record<string, unknown> = {
      login: {
        accountId: opts.accountId,
        remember: true,
      },
    };
    if (!isCustomerServiceOidcClient(opts.clientId)) {
      return result;
    }
    const consent = await buildConsentResult({
      provider: opts.provider,
      clientId: opts.clientId as string,
      accountId: opts.accountId,
      scope: opts.scope,
      params: opts.params,
    });
    if (consent instanceof NextResponse) {
      return consent;
    }
    return { ...result, ...consent };
  }

  if (opts.promptName !== "consent") {
    return {};
  }

  if (opts.action === "deny") {
    return {
      error: "access_denied",
      error_description: "User denied the authorization request",
    };
  }

  return buildConsentResult({
    provider: opts.provider,
    clientId: opts.clientId as string,
    accountId: opts.accountId,
    scope: opts.scope,
    params: opts.params,
    appClientId: opts.appClientId,
  });
}

export async function handleOidcInteractionGet(
  _request: NextRequest,
  uid: string,
): Promise<NextResponse> {
  const provider = await getProvider();

  try {
    const details = await provider.Interaction.find(uid);
    if (!details) {
      return NextResponse.json(
        {
          error: "interaction_not_found",
          error_description: "Interaction session not found or expired",
        },
        { status: 404 },
      );
    }
    const clientId = details.params.client_id as string | undefined;
    let clientName: string | undefined;
    if (clientId) {
      const client = await provider.Client.find(clientId);
      if (typeof client?.clientName === "string" && client.clientName) {
        clientName = client.clientName;
      }
    }

    return NextResponse.json({
      uid: details.uid,
      prompt: details.prompt,
      params: details.params,
      session: details.session,
      clientName,
    });
  } catch (err) {
    if (DEBUG_OIDC_LOGS) {
      console.warn("[OIDC] interaction GET failed", { uid, err });
    }
    return NextResponse.json(
      {
        error: "interaction_not_found",
        error_description: "Interaction session not found or expired",
      },
      { status: 404 },
    );
  }
}

async function readInteractionBody(
  request: NextRequest,
): Promise<{ action?: "approve" | "deny"; app_client_id?: string }> {
  if (request.method === "GET") {
    return {};
  }
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      const body: { action?: "approve" | "deny"; app_client_id?: string } = {};
      const action = formData.get("action");
      if (action === "approve" || action === "deny") {
        body.action = action;
      }
      const appClientId = formData.get("app_client_id");
      if (typeof appClientId === "string" && appClientId.trim()) {
        body.app_client_id = appClientId.trim();
      }
      return body;
    }
    return await request.json();
  } catch {
    return {};
  }
}

export async function handleOidcInteractionPost(
  request: NextRequest,
  uid: string,
): Promise<NextResponse> {
  const provider = await getProvider();
  const body = await readInteractionBody(request);

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
    const details = await provider.Interaction.find(uid);
    if (!details) {
      return NextResponse.json(
        {
          error: "interaction_not_found",
          error_description: "Interaction session not found or expired",
        },
        { status: 404 },
      );
    }
    const result = await interactionSubmissionResult({
      provider,
      promptName: details.prompt.name,
      clientId: details.params.client_id as string | undefined,
      scope: details.params.scope as string | undefined,
      params: details.params as Record<string, unknown>,
      accountId: userId,
      action: body.action,
      appClientId: body.app_client_id,
    });
    if (result instanceof NextResponse) {
      return result;
    }

    details.result = result;
    await details.persist();
    const redirectTo = details.returnTo;
    const response = NextResponse.redirect(redirectTo, { status: 302 });
    const ttlSeconds =
      typeof details.exp === "number"
        ? details.exp - Math.floor(Date.now() / 1000)
        : 1800;
    attachHandshakeCookies(provider, uid, redirectTo, ttlSeconds, response);
    return response;
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
