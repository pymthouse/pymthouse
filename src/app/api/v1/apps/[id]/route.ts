import { NextRequest, NextResponse } from "next/server";
import {
  appEditForbiddenResponse,
  canEditProviderApp,
  getAuthorizedProviderApp,
} from "@/domains/developer-apps/runtime/provider-access";
import { readAuthorizedAppDetail } from "@/domains/developer-apps/runtime/app-detail";
import {
  deleteAuthorizedDraftApp,
  updateAuthorizedApp,
} from "@/domains/developer-apps/runtime/app-core";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    canEdit: await canEditProviderApp(auth),
    ...(await readAuthorizedAppDetail(clientId, auth)),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const result = await updateAuthorizedApp(auth, await request.json());
  if (!result.ok) {
    return result.response;
  }

  return NextResponse.json(result.body);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await deleteAuthorizedDraftApp(auth);
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return new NextResponse(null, { status: 204 });
}
