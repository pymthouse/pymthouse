import { NextRequest, NextResponse } from "next/server";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { getHostedAdminClient } from "@/lib/openmeter/admin-client";
import { listTenantInvoices } from "@/lib/openmeter/invoices";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") || "1");
  const pageSize = Number(url.searchParams.get("pageSize") || "20");

  try {
    const client = getHostedAdminClient();
    const result = await listTenantInvoices({
      client,
      clientId: auth.app.id,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
