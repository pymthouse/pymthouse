import { eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { developerApps, oidcClients } from "@/db/schema";
import {
  authenticateAppClient,
  authenticateRequestAsync,
  hasScope,
} from "@/lib/auth";
import { checkRateLimit } from "@/lib/x402/rate-limit";

export type X402AppContext = {
  /** Public app_* client id (preferred). */
  appId: string;
  /** Authenticated client id (m2m_* or app_*). */
  clientId: string;
  scopes: string;
  x402Enabled: boolean;
  onrampEnabled: boolean;
  x402PayToAddress: string | null;
  authMode: "m2m" | "public_client" | "bearer";
  /** End-user id from bearer JWT when present. */
  externalUserId?: string | null;
};

async function loadAppByClientId(clientId: string) {
  const rows = await db
    .select({
      id: developerApps.id,
      oidcClientId: developerApps.oidcClientId,
      m2mOidcClientId: developerApps.m2mOidcClientId,
      x402Enabled: developerApps.x402Enabled,
      onrampEnabled: developerApps.onrampEnabled,
      x402PayToAddress: developerApps.x402PayToAddress,
    })
    .from(developerApps)
    .where(
      or(
        eq(developerApps.id, clientId),
        eq(developerApps.oidcClientId, clientId),
        eq(developerApps.m2mOidcClientId, clientId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function resolvePublicClientId(clientId: string): Promise<{
  appId: string;
  scopes: string;
} | null> {
  const trimmed = clientId.trim();
  if (!trimmed.startsWith("app_")) {
    return null;
  }
  const clientRows = await db
    .select({
      id: oidcClients.id,
      clientId: oidcClients.clientId,
      allowedScopes: oidcClients.allowedScopes,
      clientSecretHash: oidcClients.clientSecretHash,
    })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);
  const client = clientRows[0];
  if (!client || client.clientSecretHash) {
    return null;
  }
  const app = await loadAppByClientId(client.id);
  if (!app) {
    return null;
  }
  return { appId: app.id, scopes: client.allowedScopes };
}

/**
 * Auth for /verify and payment-codes:
 * - M2M Basic (preferred for resource servers)
 * - Public app_* client_id (query/body/header) with rate limiting
 * - Bearer user access JWT / pmth_* session
 */
export async function authenticateX402AgentOrApp(
  request: Request,
  options?: {
    requireSettleScope?: boolean;
    rateLimitKeyPrefix?: string;
  },
): Promise<{ ok: true; context: X402AppContext } | { ok: false; response: NextResponse }> {
  const m2m = await authenticateAppClient(request);
  if (m2m) {
    if (options?.requireSettleScope && !hasScope(m2m.scopes, "x402:settle")) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Forbidden: requires 'x402:settle' scope" },
          { status: 403 },
        ),
      };
    }
    const app = await loadAppByClientId(m2m.appId);
    if (!app) {
      return {
        ok: false,
        response: NextResponse.json({ error: "App not found" }, { status: 404 }),
      };
    }
    return {
      ok: true,
      context: {
        appId: app.id,
        clientId: m2m.clientId,
        scopes: m2m.scopes,
        x402Enabled: app.x402Enabled === 1,
        onrampEnabled: app.onrampEnabled === 1,
        x402PayToAddress: app.x402PayToAddress,
        authMode: "m2m",
      },
    };
  }

  if (options?.requireSettleScope) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const bearer = await authenticateRequestAsync(request as NextRequest);
  if (bearer?.appId) {
    const app = await loadAppByClientId(bearer.appId);
    if (!app) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }
    return {
      ok: true,
      context: {
        appId: app.id,
        clientId: bearer.appId,
        scopes: bearer.scopes || "",
        x402Enabled: app.x402Enabled === 1,
        onrampEnabled: app.onrampEnabled === 1,
        x402PayToAddress: app.x402PayToAddress,
        authMode: "bearer",
        externalUserId: bearer.endUserId,
      },
    };
  }

  const url = new URL(request.url);
  let publicClientId =
    url.searchParams.get("client_id")?.trim() ||
    request.headers.get("x-pmth-client-id")?.trim() ||
    "";

  if (!publicClientId && request.method !== "GET" && request.method !== "HEAD") {
    try {
      const clone = request.clone();
      const body = (await clone.json()) as { client_id?: string; clientId?: string };
      publicClientId =
        body.client_id?.trim() || body.clientId?.trim() || "";
    } catch {
      // ignore body parse errors; auth will fail below
    }
  }

  if (!publicClientId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const prefix = options?.rateLimitKeyPrefix || "x402";
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const limit = checkRateLimit({
    key: `${prefix}:${publicClientId}:${ip}`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Rate limit exceeded" },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000) || 1),
          },
        },
      ),
    };
  }

  const resolved = await resolvePublicClientId(publicClientId);
  if (!resolved) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const app = await loadAppByClientId(resolved.appId);
  if (!app) {
    return {
      ok: false,
      response: NextResponse.json({ error: "App not found" }, { status: 404 }),
    };
  }

  return {
    ok: true,
    context: {
      appId: app.id,
      clientId: publicClientId,
      scopes: resolved.scopes,
      x402Enabled: app.x402Enabled === 1,
      onrampEnabled: app.onrampEnabled === 1,
      x402PayToAddress: app.x402PayToAddress,
      authMode: "public_client",
    },
  };
}

export async function requireX402EnabledApp(
  context: X402AppContext,
): Promise<NextResponse | null> {
  if (!context.x402Enabled) {
    return NextResponse.json(
      { error: "x402 payments are not enabled for this app" },
      { status: 403 },
    );
  }
  return null;
}
