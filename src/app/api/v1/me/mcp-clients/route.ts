import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";

import {
  isMcpCatalogClientId,
  type McpCatalogClientId,
} from "@/lib/mcp/catalog";
import {
  linkMcpCatalogClient,
  listMcpCatalogClientStatuses,
} from "@/lib/mcp/catalog-grants";
import { authOptions } from "@/lib/next-auth-options";

function sessionUser(session: Session | null): {
  userId: string;
  email: string | null;
} | null {
  const user = session?.user as
    | { id?: unknown; email?: unknown }
    | undefined;
  if (typeof user?.id !== "string" || !user.id) return null;
  return {
    userId: user.id,
    email: typeof user.email === "string" ? user.email : null,
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = sessionUser(session);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clients = await listMcpCatalogClientStatuses(user.userId);
  return NextResponse.json({ clients });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const user = sessionUser(session);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id =
    body && typeof body === "object" && "id" in body
      ? (body as { id?: unknown }).id
      : null;
  if (typeof id !== "string" || !isMcpCatalogClientId(id)) {
    return NextResponse.json({ error: "Unknown MCP client" }, { status: 400 });
  }

  const client = await linkMcpCatalogClient({
    userId: user.userId,
    catalogClientId: id as McpCatalogClientId,
    email: user.email,
  });
  return NextResponse.json({ client });
}
