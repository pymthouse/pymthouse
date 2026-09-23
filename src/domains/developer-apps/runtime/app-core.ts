import { NextResponse } from "next/server";
import {
  ensureM2mBackendClient,
  syncBackendM2mAllowedScopesFromPublicApp,
  updateClientConfig,
} from "@/domains/oidc-platform/runtime/clients";
import { resetProvider } from "@/domains/oidc-platform/runtime/provider-instance";
import { deleteDeveloperAppAndRelatedData } from "@/domains/developer-apps/repo/delete-app";
import {
  appEditForbiddenResponse,
  canEditProviderApp,
  type AuthorizedProviderApp,
} from "./provider-access";
import {
  getM2mClientSummaryForApp,
  getOidcClientByRowId,
  transitionAppStatus,
  updateDeveloperApp,
} from "../repo/app-core";
import { hasClientConfigUpdates, parseAppCoreUpdate } from "../service/app-core";

export async function updateAuthorizedApp(
  auth: AuthorizedProviderApp,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; body: { success: true; m2mOidcClient: { clientId: string; hasSecret: boolean } | null } }
  | { ok: false; response: NextResponse }
> {
  if (!(await canEditProviderApp(auth))) {
    return { ok: false, response: appEditForbiddenResponse() };
  }

  const existingClient = auth.app.oidcClientId
    ? await getOidcClientByRowId(auth.app.oidcClientId)
    : null;
  const parsed = parseAppCoreUpdate(body, existingClient);

  await updateDeveloperApp(auth.app.id, parsed.appUpdates);

  if (existingClient && hasClientConfigUpdates(parsed.clientUpdates)) {
    await updateClientConfig(existingClient.clientId, parsed.clientUpdates);
    resetProvider();
  }

  let m2mAfter: { clientId: string; hasSecret: boolean } | null = null;
  if (parsed.backendDeviceHelper) {
    await ensureM2mBackendClient({
      appInternalId: auth.app.id,
      appDisplayName:
        typeof body.name === "string" && body.name.trim() ? body.name.trim() : auth.app.name,
    });
    resetProvider();
    m2mAfter = await getM2mClientSummaryForApp(auth.app.id);
  }

  if (await syncBackendM2mAllowedScopesFromPublicApp(auth.app.id)) {
    resetProvider();
  }

  return { ok: true, body: { success: true, m2mOidcClient: m2mAfter } };
}

export async function deleteAuthorizedDraftApp(
  auth: AuthorizedProviderApp,
): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 400; body: { error: string } }
> {
  if (auth.app.ownerId !== auth.userId) {
    return {
      ok: false,
      status: 403,
      body: { error: "Only the app owner can delete this app." },
    };
  }

  if (auth.app.status !== "draft") {
    return {
      ok: false,
      status: 400,
      body: { error: "Only draft apps can be deleted." },
    };
  }

  await deleteDeveloperAppAndRelatedData(auth.app.id, auth.app.oidcClientId ?? null);
  return { ok: true };
}

export async function submitOwnedAppForReview(params: {
  app: { id: string; ownerId: string; status: string };
  userId: string;
}): Promise<
  | { ok: true; body: { success: true; status: "submitted"; message: string } }
  | { ok: false; status: 403 | 409; body: { error: string; message?: string } }
> {
  if (params.app.ownerId !== params.userId) {
    return {
      ok: false,
      status: 403,
      body: { error: "Only the app owner can submit for review" },
    };
  }

  const now = new Date().toISOString();
  const updated = await transitionAppStatus({
    appId: params.app.id,
    allowedCurrentStatuses: ["draft", "rejected"],
    nextStatus: "submitted",
    submittedAt: now,
    updatedAt: now,
  });
  if (updated.length === 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "Invalid status",
        message: `App is currently ${params.app.status}. Only draft or rejected apps can be submitted for review.`,
      },
    };
  }

  return {
    ok: true,
    body: { success: true, status: "submitted", message: "App submitted for review" },
  };
}

export async function revertOwnedAppToDraft(params: {
  app: { id: string; ownerId: string; status: string };
  userId: string;
}): Promise<
  | { ok: true; body: { success: true; status: "draft"; message: string } }
  | { ok: false; status: 403 | 409; body: { error: string; message?: string } }
> {
  if (params.app.ownerId !== params.userId) {
    return {
      ok: false,
      status: 403,
      body: { error: "Only the app owner can revert a submitted app to draft" },
    };
  }

  const now = new Date().toISOString();
  const updated = await transitionAppStatus({
    appId: params.app.id,
    allowedCurrentStatuses: ["submitted"],
    nextStatus: "draft",
    submittedAt: null,
    updatedAt: now,
  });
  if (updated.length === 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "Invalid status",
        message: `App is currently ${params.app.status}. Only submitted apps can be reverted to draft.`,
      },
    };
  }

  return {
    ok: true,
    body: { success: true, status: "draft", message: "App reverted to draft" },
  };
}

export function publishAppMarketplaceDisabled() {
  return {
    published: false,
    reason: "marketplace_publish_disabled",
  };
}
