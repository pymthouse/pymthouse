import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authenticateAppClient } from "@/lib/auth";
import { buildAppManifestForApp } from "@/lib/app-manifest";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  getProviderApp,
} from "@/lib/provider-apps";
import {
  ALLOW_ALL_MANIFEST_ETAG,
  ALLOW_ALL_MANIFEST_RESPONSE,
  DiscoveryAllowlistUpdateBodySchema,
  normalizeDiscoveryAllowlistDoc,
} from "@/lib/discovery-allowlist";
import { fetchPipelineCatalog } from "@/lib/naap-catalog";
import {
  findCustomPlansBlockingNewExclusions,
  getOrCreateNetworkDefaultPlan,
} from "@/lib/network-default-plan";

async function resolveAppForPlansRead(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    return getProviderApp(clientId);
  }

  const auth = await getAuthorizedProviderApp(clientId, request);
  return auth?.app ?? null;
}

function requestMatchesIfNoneMatch(request: NextRequest, etag: string): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some(
      (value) =>
        value === "*" ||
        value === etag ||
        value === `W/${etag}` ||
        (value.startsWith("W/") && value.slice(2) === etag),
    );
}

/**
 * App network capability manifest for integrators (e.g. NaaP).
 * GET: allow-all snapshot (empty capabilities/exclusions). M2M Basic or provider session.
 * PUT: provider session — update Network Price exclusions only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForPlansRead(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (requestMatchesIfNoneMatch(request, ALLOW_ALL_MANIFEST_ETAG)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: ALLOW_ALL_MANIFEST_ETAG },
    });
  }
  return NextResponse.json(ALLOW_ALL_MANIFEST_RESPONSE, {
    headers: { ETag: ALLOW_ALL_MANIFEST_ETAG },
  });
}

export async function HEAD(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForPlansRead(clientId, request);
  if (!app) {
    return new NextResponse(null, { status: 404 });
  }

  if (requestMatchesIfNoneMatch(request, ALLOW_ALL_MANIFEST_ETAG)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: ALLOW_ALL_MANIFEST_ETAG },
    });
  }

  return new NextResponse(null, {
    status: 200,
    headers: { ETag: ALLOW_ALL_MANIFEST_ETAG },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth?.app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canEditProviderApp(auth))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = DiscoveryAllowlistUpdateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  const networkPlan = await getOrCreateNetworkDefaultPlan(auth.app.id, db);
  const excludedCapabilities = parsed.data.excludedCapabilities;
  const newExcludedDoc = normalizeDiscoveryAllowlistDoc({
    capabilities: excludedCapabilities,
  });

  let catalogLite;
  try {
    const catalog = await fetchPipelineCatalog();
    catalogLite = catalog.map((e) => ({ id: e.id, models: e.models }));
  } catch {
    return NextResponse.json(
      { error: "Pipeline catalog unavailable" },
      { status: 503 },
    );
  }

  const now = new Date().toISOString();
  let blocked: Awaited<ReturnType<typeof findCustomPlansBlockingNewExclusions>> = [];
  await db.transaction(async (tx) => {
    blocked = await findCustomPlansBlockingNewExclusions(
      auth.app.id,
      catalogLite,
      newExcludedDoc,
      tx,
    );
    if (blocked.length > 0) {
      return;
    }
    await tx
      .update(plans)
      .set({
        updatedAt: now,
        discoveryExcludedCapabilities: newExcludedDoc,
      })
      .where(eq(plans.id, networkPlan.id));
  });
  if (blocked.length > 0) {
    return NextResponse.json(
      {
        error:
          "Cannot exclude pipeline/models that are still priced on a custom plan. Remove those bundles first.",
        conflicts: blocked,
      },
      { status: 409 },
    );
  }

  const responseBody = await buildAppManifestForApp(auth.app.id);
  return NextResponse.json(responseBody);
}
