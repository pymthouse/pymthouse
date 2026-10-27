import type { NextRequest } from "next/server";
import { discoveryPolicyFromDb } from "@/shared/discovery/discovery-plans";
import { getDiscoveryProfile, listDiscoveryProfiles } from "../repo/discovery-profiles";
import { resolveReadablePlansApp } from "./plans-read";

export async function resolveReadableDiscoveryProfilesApp(clientId: string, request: NextRequest) {
  return resolveReadablePlansApp(clientId, request);
}

export async function readDiscoveryProfiles(clientId: string, appId: string) {
  const { profs, bundles } = await listDiscoveryProfiles(appId);
  return profs.map((p) => ({
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
  }));
}

export async function readDiscoveryProfile(clientId: string, appId: string, profileId: string) {
  const result = await getDiscoveryProfile(appId, profileId);
  if (!result) return null;
  return {
    id: result.profile.id,
    clientId,
    name: result.profile.name,
    policy: discoveryPolicyFromDb(result.profile.policy),
    createdAt: result.profile.createdAt,
    updatedAt: result.profile.updatedAt,
    capabilities: result.bundles.map((b) => ({
      pipeline: b.pipeline,
      modelId: b.modelId,
      discoveryPolicy: discoveryPolicyFromDb(b.discoveryPolicy),
    })),
  };
}
