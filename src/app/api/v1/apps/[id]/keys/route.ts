import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/domains/developer-apps/runtime/provider-access";
import {
  createAppKey,
  readAppKeys,
  revokeExistingAppKey,
} from "@/domains/developer-apps/runtime/app-keys";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(await readAppKeys(clientId, auth.app.id));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const appId = auth.app.id;

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined;
  const result = await createAppKey({
    clientId,
    appId,
    actorUserId: userId || null,
    body: await request.json().catch(() => ({})),
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const appId = auth.app.id;

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const { searchParams } = new URL(request.url);
  const session = await getServerSession(authOptions);
  const actorUserId = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined;
  const result = await revokeExistingAppKey({
    appId,
    actorUserId: actorUserId || null,
    keyId: searchParams.get("keyId"),
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}
