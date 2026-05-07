import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { discoveryProfileBundles, discoveryProfiles } from "@/db/schema";
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForDiscoveryProfilesRead(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const appId = app.id;
  const profs = await db
    .select()
    .from(discoveryProfiles)
    .where(eq(discoveryProfiles.clientId, appId));
  const bundles = await db
    .select()
    .from(discoveryProfileBundles)
    .where(eq(discoveryProfileBundles.clientId, appId));

  return NextResponse.json({
    profiles: profs.map((p) => ({
      id: p.id,
      clientId,
      name: p.name,
      policy: discoveryPolicyFromDb(p.policy),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      capabilities: bundles
        .filter((b) => b.profileId === p.id)
        .map((b) => ({
          pipeline: b.pipeline,
          modelId: b.modelId,
          discoveryPolicy: discoveryPolicyFromDb(b.discoveryPolicy),
        })),
    })),
  });
}

export async function POST(
  request: NextRequest,
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const name = String(body.name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const policyParsed = parseDiscoveryPolicyInput(body.policy, "policy");
  if (!policyParsed.ok) {
    return NextResponse.json({ error: policyParsed.error }, { status: 400 });
  }

  const parsedCaps = parseDiscoveryProfileCapabilities(body.capabilities);
  if (parsedCaps.error) {
    return NextResponse.json({ error: parsedCaps.error }, { status: 400 });
  }

  const profileId = uuidv4();
  const now = new Date().toISOString();
  const appId = auth.app.id;

  try {
    await db.transaction(async (tx) => {
      await tx.insert(discoveryProfiles).values({
        id: profileId,
        clientId: appId,
        name,
        policy: policyParsed.policy,
        createdAt: now,
        updatedAt: now,
      });

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
      return NextResponse.json({ error: "A discovery profile with this name already exists" }, { status: 400 });
    }
    throw e;
  }

  return NextResponse.json({ id: profileId }, { status: 201 });
}
