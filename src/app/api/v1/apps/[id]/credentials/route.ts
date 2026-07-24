import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { oidcClients } from "@/db/schema";
import { eq } from "drizzle-orm";
import { rotateClientSecret } from "@/lib/oidc/clients";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";

type CredentialsTarget = "m2m" | "web" | "primary";

function parseTarget(request: NextRequest): CredentialsTarget {
  const raw = new URL(request.url).searchParams.get("target");
  if (raw === "web" || raw === "m2m" || raw === "primary") return raw;
  return "m2m";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const { app } = auth;

  if (!app.oidcClientId) {
    return NextResponse.json(
      { error: "App has no OIDC client configured" },
      { status: 400 },
    );
  }

  const target = parseTarget(request);
  let targetOidcRowId: string | null = null;

  if (target === "web") {
    targetOidcRowId = app.webOidcClientId ?? null;
    if (!targetOidcRowId) {
      return NextResponse.json(
        {
          error: "confidential_web_not_enabled",
          error_description:
            "Enable Confidential web RP on App profile, then generate a secret for the web_ client.",
        },
        { status: 400 },
      );
    }
  } else if (target === "m2m") {
    targetOidcRowId = app.m2mOidcClientId ?? null;
    if (!targetOidcRowId) {
      // Legacy: if no M2M, allow rotating primary when it is confidential and no siblings.
      if (app.webOidcClientId) {
        return NextResponse.json(
          {
            error: "interactive_public_no_secret",
            error_description:
              "Public apps cannot hold a client secret. Enable Confidential M2M backend for machine credentials, or use ?target=web for the confidential web RP.",
          },
          { status: 400 },
        );
      }
      const primaryRows = await db
        .select()
        .from(oidcClients)
        .where(eq(oidcClients.id, app.oidcClientId))
        .limit(1);
      const primary = primaryRows[0];
      if (!primary) {
        return NextResponse.json(
          { error: "OIDC client not found" },
          { status: 500 },
        );
      }
      if (primary.tokenEndpointAuthMethod === "none") {
        return NextResponse.json(
          {
            error: "interactive_public_no_secret",
            error_description:
              "Public apps cannot hold a client secret. Enable Confidential M2M backend for machine credentials, or Confidential web RP for portal SSO (auth code + secret + redirects).",
          },
          { status: 400 },
        );
      }
      targetOidcRowId = app.oidcClientId;
    }
  } else {
    // target === primary — only when no confidential siblings
    if (app.m2mOidcClientId || app.webOidcClientId) {
      return NextResponse.json(
        {
          error: "public_client_no_secret",
          error_description:
            "The public app_ client cannot hold a secret while a confidential sibling exists. Use ?target=m2m or ?target=web.",
        },
        { status: 400 },
      );
    }
    targetOidcRowId = app.oidcClientId;
  }

  const clientRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, targetOidcRowId))
    .limit(1);
  const client = clientRows[0];

  if (!client) {
    return NextResponse.json(
      { error: "OIDC client not found" },
      { status: 500 },
    );
  }

  if (client.tokenEndpointAuthMethod === "none") {
    return NextResponse.json(
      {
        error: "public_client_no_secret",
        error_description:
          "This client cannot hold a secret. Use the M2M backend helper or confidential web RP for confidential credentials.",
      },
      { status: 400 },
    );
  }

  const secret = await rotateClientSecret(client.clientId);
  if (!secret) {
    return NextResponse.json(
      { error: "Failed to generate secret" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    clientId: client.clientId,
    clientSecret: secret,
    target,
    message: "Store this secret securely. It will not be shown again.",
  });
}
