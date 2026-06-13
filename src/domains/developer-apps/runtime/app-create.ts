import {
  createAppClient,
  ensureM2mBackendClient,
  updateClientConfig,
} from "@/domains/oidc-platform/runtime/clients";
import { resetProvider } from "@/domains/oidc-platform/runtime/provider-instance";
import {
  ensureProviderAdminMembership,
  listAppsVisibleToUser,
} from "../repo/provider-access";
import { createDeveloperAppRecord } from "../repo/app-create";
import { hasClientConfigUpdates } from "../service/app-core";
import { parseAppCreateInput } from "../service/app-create";

export async function readVisibleAppsForUser(userId: string) {
  return { apps: await listAppsVisibleToUser(userId) };
}

export async function createDeveloperAppForUser(
  userId: string,
  body: unknown,
): Promise<
  | { ok: true; body: { id: string; clientId: string; status: "draft" } }
  | { ok: false; status: 400; body: { error: string } }
> {
  const parsed = parseAppCreateInput(body);
  if (!parsed.ok) {
    return parsed;
  }

  const { id: oidcRowId, clientId } = await createAppClient(parsed.value.name);
  if (hasClientConfigUpdates(parsed.value.clientUpdates)) {
    await updateClientConfig(clientId, parsed.value.clientUpdates);
  }

  const now = new Date().toISOString();
  await createDeveloperAppRecord({
    id: clientId,
    ownerId: userId,
    oidcClientId: oidcRowId,
    name: parsed.value.name,
    developerName: parsed.value.developerName,
    websiteUrl: parsed.value.websiteUrl,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  if (parsed.value.backendDeviceHelper) {
    await ensureM2mBackendClient({
      appInternalId: clientId,
      appDisplayName: parsed.value.name,
    });
  }

  resetProvider();
  await ensureProviderAdminMembership(userId, clientId);

  return { ok: true, body: { id: clientId, clientId, status: "draft" } };
}
