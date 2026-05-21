import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authenticateAppClient } from "@/lib/auth";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  getProviderApp,
} from "@/lib/provider-apps";
import {
  DiscoveryAllowlistUpdateBodySchema,
  normalizeDiscoveryAllowlistDoc,
  resolveDiscoveryCapabilitiesForExclusions,
} from "@/lib/discovery-allowlist";
import { fetchPipelineCatalog } from "@/lib/naap-catalog";
import {
  findCustomPlansBlockingNewExclusions,
  getOrCreateNetworkDefaultPlan,
  selectNetworkDefaultPlan,
} from "@/lib/network-default-plan";

async function resolveAppForPlansRead(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    return getProviderApp(clientId);
  }

  const auth = await getAuthorizedProviderApp(clientId);
  return auth?.app ?? null;
}

async function buildDiscoveryAllowlistJson(appInternalId: string) {
  const row =
    (await selectNetworkDefaultPlan(appInternalId, db)) ??
    (await getOrCreateNetworkDefaultPlan(appInternalId, db));
  const rawExcluded = row.discoveryExcludedCapabilities ?? null;
  const excludedDoc = normalizeDiscoveryAllowlistDoc(rawExcluded);

  let catalog;
  try {
    catalog = await fetchPipelineCatalog();
  } catch {
    return null;
  }

  const lite = catalog.map((e) => ({ id: e.id, models: e.models }));
  return resolveDiscoveryCapabilitiesForExclusions(lite, excludedDoc);
}

/**
 * App-level pipeline/model allowlist for integrator discovery (e.g. NaaP).
 * Backed by the per-app Network Price plan exclusions. GET: M2M Basic or provider session.
 * PUT: provider session with edit rights.
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

  const body = await buildDiscoveryAllowlistJson(app.id);
  if (body === null) {
    return NextResponse.json(
      { error: "Pipeline catalog unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json(body);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
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
  const newExcludedDoc = normalizeDiscoveryAllowlistDoc({
    capabilities: parsed.data.excludedCapabilities,
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

  const blocked = await findCustomPlansBlockingNewExclusions(
    auth.app.id,
    catalogLite,
    newExcludedDoc,
    db,
  );
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

  const now = new Date().toISOString();
  await db
    .update(plans)
    .set({
      updatedAt: now,
      discoveryExcludedCapabilities: {
        capabilities: parsed.data.excludedCapabilities,
      },
    })
    .where(eq(plans.id, networkPlan.id));

  const responseBody = await buildDiscoveryAllowlistJson(auth.app.id);
  if (responseBody === null) {
    return NextResponse.json(
      { error: "Pipeline catalog unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json(responseBody);
}
