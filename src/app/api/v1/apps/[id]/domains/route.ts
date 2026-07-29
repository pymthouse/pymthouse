import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/index";
import { appAllowedDomains } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { invalidateAppCorsCache } from "@/lib/api-cors";
import { normalizeDomainWhitelist } from "@/lib/domain-whitelist";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";

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

  const domains = await db
    .select()
    .from(appAllowedDomains)
    .where(eq(appAllowedDomains.appId, app.id));

  return NextResponse.json({ domains });
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
  const { domain } = body;

  if (!domain || typeof domain !== "string") {
    return NextResponse.json(
      { error: "domain is required" },
      { status: 400 }
    );
  }

  // Normalize and validate the domain
  const result = normalizeDomainWhitelist(domain);
  if (!result.success) {
    return NextResponse.json(
      { error: result.error },
      { status: 400 }
    );
  }

  const normalizedDomain = result.normalized;

  // Check for duplicates
  const existingDomains = await db
    .select()
    .from(appAllowedDomains)
    .where(eq(appAllowedDomains.appId, app.id));

  const isDuplicate = existingDomains.some(
    (d) => d.domain.toLowerCase() === normalizedDomain.toLowerCase()
  );

  if (isDuplicate) {
    return NextResponse.json(
      { error: `Domain "${normalizedDomain}" is already in the whitelist` },
      { status: 409 }
    );
  }

  const domainId = uuidv4();
  try {
    await db.insert(appAllowedDomains).values({
      id: domainId,
      appId: app.id,
      domain: normalizedDomain,
    });
  } catch (err: unknown) {
    // Handle unique constraint violation (Postgres error code 23505)
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      return NextResponse.json(
        { error: `Domain "${normalizedDomain}" is already in the whitelist` },
        { status: 409 }
      );
    }
    throw err;
  }

  invalidateAppCorsCache();
  return NextResponse.json({ id: domainId, domain: normalizedDomain }, { status: 201 });
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
  const domainId = searchParams.get("domainId");

  if (!domainId) {
    return NextResponse.json(
      { error: "domainId query parameter is required" },
      { status: 400 }
    );
  }

  await db.delete(appAllowedDomains).where(
    and(
      eq(appAllowedDomains.id, domainId),
      eq(appAllowedDomains.appId, app.id),
    ),
  );

  invalidateAppCorsCache();
  return NextResponse.json({ success: true });
}
