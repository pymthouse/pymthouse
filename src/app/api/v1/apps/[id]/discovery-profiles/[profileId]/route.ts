import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { discoveryProfileBundles, discoveryProfiles, plans } from "@/db/schema";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  getProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { authenticateAppClient } from "@/lib/auth";
import type { DiscoveryPolicy } from "@/lib/discovery-plans";
import { discoveryPolicyFromDb, parseDiscoveryPolicyInput } from "@/lib/discovery-plans";

function parseDiscoveryProfileCapabilities(input: unknown): {
  capabilities: Array<{ pipeline: string; modelId: string; discoveryPolicy: DiscoveryPolicy | null }>;
  error?: string;
} {
  if (input === undefined) {
    return { capabilities: [] };
  }
  if (!Array.isArray(input)) {
    return { capabilities: [], error: "capabilities must be an array" };
  }
  try {
    const seen = new Set<string>();
    const capabilities = input.map((raw, index) => {
      const value = (raw ?? {}) as Record<string, unknown>;
      const pipeline = typeof value.pipeline === "string" ? value.pipeline.trim() : "";
      const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
      if (!pipeline) {
        throw new Error(`capabilities[${index}].pipeline is required`);
      }
      if (!modelId) {
        throw new Error(`capabilities[${index}].modelId is required`);
      }
      const capKey = `${pipeline}::${modelId}`;
      if (seen.has(capKey)) {
        throw new Error(
          `duplicate capability at capabilities[${index}] for pipeline "${pipeline}" and modelId "${modelId}"`,
        );
      }
      seen.add(capKey);
      const dp = parseDiscoveryPolicyInput(
        value.discoveryPolicy,
        `capabilities[${index}].discoveryPolicy`,
      );
      if (!dp.ok) {
        throw new Error(dp.error);
      }
      return { pipeline, modelId, discoveryPolicy: dp.policy };
    });
    return { capabilities };
  } catch (err) {
    return {
      capabilities: [],
      error: err instanceof Error ? err.message : "Invalid capabilities",
    };
  }
}

async function resolveAppForDiscoveryProfilesRead(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    return getProviderApp(clientId);
  }
  const auth = await getAuthorizedProviderApp(clientId);
  return auth?.app ?? null;
}

function parsePutDiscoveryProfileBody(body: unknown): {
  ok: true;
  record: Record<string, unknown>;
} | { ok: false; response: NextResponse } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "invalid JSON" }, { status: 400 }),
    };
  }
  return { ok: true, record: body as Record<string, unknown> };
}

async function applyDiscoveryProfileUpdates(input: {
  appId: string;
  profileId: string;
  setFields: {
    name: string;
    updatedAt: string;
    policy?: DiscoveryPolicy | null;
  };
  parsedCaps: ReturnType<typeof parseDiscoveryProfileCapabilities> | null;
  now: string;
}): Promise<NextResponse | null> {
  const { appId, profileId, setFields, parsedCaps, now } = input;
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(discoveryProfiles)
        .set(setFields)
        .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)));

      if (!parsedCaps) {
        return;
      }
      await tx
        .delete(discoveryProfileBundles)
        .where(
          and(
            eq(discoveryProfileBundles.profileId, profileId),
            eq(discoveryProfileBundles.clientId, appId),
          ),
        );
      for (const cap of parsedCaps.capabilities) {
        await tx.insert(discoveryProfileBundles).values({
          id: uuidv4(),
          profileId,
          clientId: appId,
          pipeline: cap.pipeline,
          modelId: cap.modelId,
          discoveryPolicy: cap.discoveryPolicy,
          createdAt: now,
        });
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("idx_discovery_profiles_client_name") || msg.includes("unique")) {
      return NextResponse.json(
        { error: "A discovery profile with this name already exists" },
        { status: 400 },
      );
    }
    throw e;
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id: clientId, profileId } = await params;
  const app = await resolveAppForDiscoveryProfilesRead(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, app.id)))
    .limit(1);
  const profile = rows[0];
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bundles = await db
    .select()
    .from(discoveryProfileBundles)
    .where(
      and(
        eq(discoveryProfileBundles.profileId, profileId),
        eq(discoveryProfileBundles.clientId, app.id),
      ),
    );

  return NextResponse.json({
    profile: {
      id: profile.id,
      clientId,
      name: profile.name,
      policy: discoveryPolicyFromDb(profile.policy),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      capabilities: bundles.map((b) => ({
        pipeline: b.pipeline,
        modelId: b.modelId,
        discoveryPolicy: discoveryPolicyFromDb(b.discoveryPolicy),
      })),
    },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id: clientId, profileId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsedBody = parsePutDiscoveryProfileBody(body);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const { record } = parsedBody;

  const appId = auth.app.id;
  const existingRows = await db
    .select()
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const name =
    record.name !== undefined ? String(record.name || "").trim() : existing.name;
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const now = new Date().toISOString();

  const setFields: {
    name: string;
    updatedAt: string;
    policy?: DiscoveryPolicy | null;
  } = { name, updatedAt: now };

  if (record.policy !== undefined) {
    const r = parseDiscoveryPolicyInput(record.policy, "policy");
    if (!r.ok) {
      return NextResponse.json({ error: r.error }, { status: 400 });
    }
    setFields.policy = r.policy;
  }

  let parsedCaps: ReturnType<typeof parseDiscoveryProfileCapabilities> | null = null;
  if (record.capabilities !== undefined) {
    parsedCaps = parseDiscoveryProfileCapabilities(record.capabilities);
    if (parsedCaps.error) {
      return NextResponse.json({ error: parsedCaps.error }, { status: 400 });
    }
  }

  const updateErr = await applyDiscoveryProfileUpdates({
    appId,
    profileId,
    setFields,
    parsedCaps,
    now,
  });
  if (updateErr) {
    return updateErr;
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id: clientId, profileId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const appId = auth.app.id;
  const existingRows = await db
    .select({ id: discoveryProfiles.id })
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)))
    .limit(1);
  if (!existingRows[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ref = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.discoveryProfileId, profileId))
    .limit(1);
  if (ref[0]) {
    return NextResponse.json(
      { error: "Profile is attached to one or more billing plans; detach before deleting" },
      { status: 409 },
    );
  }

  await db
    .delete(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)));

  return NextResponse.json({ success: true });
}
