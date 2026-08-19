import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { discoveryProfileBundles, discoveryProfiles, plans } from "@/db/schema";
import type {
  CreateDiscoveryProfileInput,
  UpdateDiscoveryProfileInput,
} from "../types/discovery-profiles";

export class DiscoveryProfileDuplicateNameError extends Error {}

function isDuplicateNameError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("idx_discovery_profiles_client_name") || msg.includes("unique");
}

export async function listDiscoveryProfiles(appId: string) {
  const profs = await db.select().from(discoveryProfiles).where(eq(discoveryProfiles.clientId, appId));
  const bundles = await db
    .select()
    .from(discoveryProfileBundles)
    .where(eq(discoveryProfileBundles.clientId, appId));
  return { profs, bundles };
}

export async function getDiscoveryProfile(appId: string, profileId: string) {
  const rows = await db
    .select()
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)))
    .limit(1);
  const profile = rows[0] ?? null;
  if (!profile) return null;

  const bundles = await db
    .select()
    .from(discoveryProfileBundles)
    .where(
      and(eq(discoveryProfileBundles.profileId, profileId), eq(discoveryProfileBundles.clientId, appId)),
    );
  return { profile, bundles };
}

export async function listDiscoveryProfilesByIds(profileIds: string[]) {
  if (profileIds.length === 0) return [];
  return db
    .select()
    .from(discoveryProfiles)
    .where(inArray(discoveryProfiles.id, profileIds));
}

export async function listDiscoveryProfileBundlesByProfileIds(profileIds: string[]) {
  if (profileIds.length === 0) return [];
  return db
    .select()
    .from(discoveryProfileBundles)
    .where(inArray(discoveryProfileBundles.profileId, profileIds));
}

export async function createDiscoveryProfile(appId: string, input: CreateDiscoveryProfileInput) {
  const profileId = uuidv4();
  const now = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(discoveryProfiles).values({
        id: profileId,
        clientId: appId,
        name: input.name,
        policy: input.policy,
        createdAt: now,
        updatedAt: now,
      });

      for (const cap of input.capabilities) {
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
  } catch (error) {
    if (isDuplicateNameError(error)) {
      throw new DiscoveryProfileDuplicateNameError(
        "A discovery profile with this name already exists",
      );
    }
    throw error;
  }

  return profileId;
}

export async function updateDiscoveryProfile(
  appId: string,
  profileId: string,
  input: UpdateDiscoveryProfileInput,
): Promise<{ ok: true } | { ok: false; status: 404; error: string }> {
  const existingRows = await db
    .select()
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)))
    .limit(1);
  if (!existingRows[0]) {
    return { ok: false, status: 404, error: "Not found" };
  }

  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(discoveryProfiles)
        .set({
          name: input.name,
          updatedAt: now,
          ...(input.policy !== undefined ? { policy: input.policy } : {}),
        })
        .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)));

      if (input.capabilities) {
        await tx
          .delete(discoveryProfileBundles)
          .where(
            and(
              eq(discoveryProfileBundles.profileId, profileId),
              eq(discoveryProfileBundles.clientId, appId),
            ),
          );
        for (const cap of input.capabilities) {
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
      }
    });
  } catch (error) {
    if (isDuplicateNameError(error)) {
      throw new DiscoveryProfileDuplicateNameError(
        "A discovery profile with this name already exists",
      );
    }
    throw error;
  }

  return { ok: true };
}

export async function deleteDiscoveryProfile(
  appId: string,
  profileId: string,
): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const existingRows = await db
    .select({ id: discoveryProfiles.id })
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)))
    .limit(1);
  if (!existingRows[0]) {
    return { ok: false, status: 404, error: "Not found" };
  }

  const ref = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.discoveryProfileId, profileId))
    .limit(1);
  if (ref[0]) {
    return {
      ok: false,
      status: 409,
      error: "Profile is attached to one or more billing plans; detach before deleting",
    };
  }

  await db
    .delete(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, profileId), eq(discoveryProfiles.clientId, appId)));
  return { ok: true };
}
