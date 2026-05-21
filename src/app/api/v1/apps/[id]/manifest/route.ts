import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authenticateAppClient } from "@/lib/auth";
import { publishCachedManifestPolicy } from "@/lib/app-manifest-cache";
import { buildAppManifestForApp } from "@/lib/app-manifest";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  getProviderApp,
} from "@/lib/provider-apps";
import {
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

/**
 * App network capability manifest for integrators (e.g. NaaP).
 * GET: resolved discoverable set + exclusions + manifestVersion. M2M Basic or provider session.
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

  const body = await buildAppManifestForApp(app.id);
  publishCachedManifestPolicy(clientId, body, "manifest_get");
  return NextResponse.json(body);
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
  publishCachedManifestPolicy(clientId, responseBody, "manifest_put");
  return NextResponse.json(responseBody);
}
