import { NextRequest, NextResponse } from "next/server";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/domains/developer-apps/runtime/provider-access";
import { publishAppMarketplaceDisabled } from "@/domains/developer-apps/runtime/app-core";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  return NextResponse.json(
    publishAppMarketplaceDisabled(),
    { status: 200 },
  );
}
