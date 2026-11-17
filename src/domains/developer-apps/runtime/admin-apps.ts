import { getPlatformJwksUrlForDatabase } from "@/platform/oidc/issuer-urls";
import {
  syncBackendM2mAllowedScopesFromPublicApp,
  updateClientConfig,
} from "@/domains/oidc-platform/runtime/clients";
import { resetProvider } from "@/domains/oidc-platform/runtime/provider-instance";
import { getProviderApp } from "../repo/provider-access";
import {
  clearPendingRevisionReview,
  listReviewableApps,
  revokeApprovedApp,
  updateInitialReviewState,
} from "../repo/admin-apps";
import { getOidcClientByRowId } from "../repo/app-core";
import { parseAdminReviewInput } from "../service/admin-apps";

export async function readAdminApps() {
  return { apps: (await listReviewableApps()) || [] };
}

export async function reviewDeveloperApp(params: {
  clientId: string;
  reviewerUserId: string;
  body: unknown;
}): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 404; body: { error: string } | { error: string; message: string } }
> {
  const app = await getProviderApp(params.clientId);
  if (!app) {
    return { ok: false, status: 404, body: { error: "Not found" } };
  }

  const parsed = parseAdminReviewInput(params.body);
  if (!parsed.ok) {
    return parsed;
  }

  const now = new Date().toISOString();
  const jwksUri = getPlatformJwksUrlForDatabase();

  if (
    app.status === "approved" &&
    app.pendingRevisionSubmittedAt &&
    app.pendingScopes &&
    app.pendingGrantTypes &&
    app.oidcClientId
  ) {
    const client = await getOidcClientByRowId(app.oidcClientId);
    if (parsed.value.action === "approve" && client) {
      await updateClientConfig(client.clientId, {
        allowedScopes: app.pendingScopes,
        grantTypes: app.pendingGrantTypes.split(",").filter(Boolean),
      });
      resetProvider();
      if (await syncBackendM2mAllowedScopesFromPublicApp(app.id)) {
        resetProvider();
      }
    }

    await clearPendingRevisionReview({
      appId: app.id,
      notes: parsed.value.action === "reject" ? parsed.value.notes : null,
      updatedAt: now,
      setJwksUri: parsed.value.action === "approve" ? jwksUri : null,
    });

    return {
      ok: true,
      body: {
        success: true,
        status: "approved",
        revisionApproved: parsed.value.action === "approve",
      },
    };
  }

  if (app.status !== "submitted" && app.status !== "in_review") {
    return {
      ok: false,
      status: 400,
      body: { error: `Cannot review app with status '${app.status}'` },
    };
  }

  const newStatus = parsed.value.action === "approve" ? "approved" : "rejected";
  await updateInitialReviewState({
    appId: app.id,
    newStatus,
    notes: parsed.value.notes,
    reviewerUserId: params.reviewerUserId,
    reviewedAt: now,
    setJwksUri: parsed.value.action === "approve" ? jwksUri : null,
  });

  return { ok: true, body: { success: true, status: newStatus } };
}

export async function revokeReviewedDeveloperApp(clientId: string): Promise<
  | { ok: true; body: { success: true; status: "submitted" } }
  | { ok: false; status: 404; body: { error: string } }
> {
  const app = await getProviderApp(clientId);
  if (!app) {
    return {
      ok: false,
      status: 404,
      body: { error: "App not found or not in approved status" },
    };
  }

  const updated = await revokeApprovedApp(app.id, new Date().toISOString());
  if (updated.length === 0) {
    return {
      ok: false,
      status: 404,
      body: { error: "App not found or not in approved status" },
    };
  }

  return { ok: true, body: { success: true, status: "submitted" } };
}
