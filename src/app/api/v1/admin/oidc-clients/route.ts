import { NextResponse } from "next/server";
import { getAllClients, getClient, updateClientConfig } from "@/lib/oidc/clients";
import { withSessionAdminGuard } from "@/lib/api-guards";

/**
 * GET /api/v1/admin/oidc-clients
 * List all registered OIDC clients.
 */
export const GET = withSessionAdminGuard(async () => {
  const clients = await getAllClients();
  return NextResponse.json({ clients });
});

/**
 * PATCH /api/v1/admin/oidc-clients
 * Update an OIDC client configuration.
 */
export const PATCH = withSessionAdminGuard(async (request) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { clientId, updates } = body as { clientId: string; updates: Record<string, unknown> };

  if (!clientId || typeof clientId !== "string") {
    return NextResponse.json(
      { error: "clientId is required" },
      { status: 400 }
    );
  }

  const client = await getClient(clientId);
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const success = await updateClientConfig(clientId, updates);

  if (!success) {
    return NextResponse.json(
      { error: "Failed to update client" },
      { status: 500 }
    );
  }

  const updated = await getClient(clientId);
  return NextResponse.json({ client: updated });
});
