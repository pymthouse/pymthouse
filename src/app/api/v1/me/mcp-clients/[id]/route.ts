import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { isMcpCatalogClientId } from "@/lib/mcp/catalog";
import { unlinkMcpCatalogClient } from "@/lib/mcp/catalog-grants";
import { authOptions } from "@/lib/next-auth-options";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: unknown } | undefined;
  if (typeof user?.id !== "string" || !user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!isMcpCatalogClientId(id)) {
    return NextResponse.json({ error: "Unknown MCP client" }, { status: 400 });
  }

  const client = await unlinkMcpCatalogClient({
    userId: user.id,
    catalogClientId: id,
  });
  return NextResponse.json({ client });
}
