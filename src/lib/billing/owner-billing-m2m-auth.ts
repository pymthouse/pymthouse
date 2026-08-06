import type { NextRequest } from "next/server";

import { authenticateAppClient } from "@/lib/auth";
import { getProviderApp } from "@/lib/provider-apps";

type ProviderApp = NonNullable<Awaited<ReturnType<typeof getProviderApp>>>;

/**
 * Authorize Owner Paid switching under Builder M2M Basic only.
 *
 * Resolves the app by path `{clientId}` and returns the app owner wallet id.
 * Provider-session auth is intentionally rejected (issue #368).
 */
export async function authorizeOwnerBillingM2m(
  request: NextRequest | Request,
  clientId: string,
): Promise<{ app: ProviderApp; ownerUserId: string } | null> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    return null;
  }

  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId !== trimmed) {
    return null;
  }

  const app = await getProviderApp(trimmed);
  const ownerUserId = app?.ownerId?.trim();
  if (!app || !ownerUserId) {
    return null;
  }

  return {
    app,
    ownerUserId,
  };
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readConfirmFlag(body: Record<string, unknown>): boolean {
  return body.confirm === true;
}
