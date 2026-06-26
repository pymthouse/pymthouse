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

export async function POST(
  _request: NextRequest,
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

  let targetOidcRowId: string | null = app.m2mOidcClientId ?? null;

  if (!targetOidcRowId) {
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
            "Enable Confidential M2M backend on App profile, then generate a secret for the confidential client.",
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
          "This client cannot hold a secret. Use the Backend helper client for confidential credentials.",
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
    message: "Store this secret securely. It will not be shown again.",
  });
}
