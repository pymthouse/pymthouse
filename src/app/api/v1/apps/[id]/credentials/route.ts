import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/domains/developer-apps/runtime/provider-access";
import { rotateAppClientSecret } from "@/domains/developer-apps/runtime/app-credentials";

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

  const result = await rotateAppClientSecret({
    oidcClientId: auth.app.oidcClientId,
    m2mOidcClientId: auth.app.m2mOidcClientId,
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}
