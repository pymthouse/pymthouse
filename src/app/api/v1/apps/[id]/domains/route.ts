import { NextRequest, NextResponse } from "next/server";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/domains/developer-apps/runtime/provider-access";
import {
  createAppDomain,
  readAppDomains,
  removeAppDomain,
} from "@/domains/developer-apps/runtime/app-domains";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  const app = auth?.app ?? null;
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ domains: await readAppDomains(app.id) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  const app = auth?.app ?? null;
  if (!auth || !app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const body = await request.json();
  const result = await createAppDomain(app.id, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result.value, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  const app = auth?.app ?? null;
  if (!auth || !app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const { searchParams } = new URL(request.url);
  const result = await removeAppDomain(app.id, searchParams.get("domainId"));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true });
}
