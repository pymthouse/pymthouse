import { PmtHouseError } from "@pymthouse/builder-sdk";
import type { WebhookAuthorizeContext } from "@pymthouse/builder-sdk/signer/webhook";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { resolveDeveloperAppIdFromAuthAppId } from "@/lib/signer-proxy";

type ClearinghouseBalanceBody = {
  balance?: {
    hasAccess?: boolean;
    remainingUsdMicros?: string;
    balanceUsdMicros?: string;
  };
};

async function resolveDeveloperApp(publicClientId: string) {
  const developerAppId = await resolveDeveloperAppIdFromAuthAppId(publicClientId);
  if (!developerAppId) {
    return null;
  }
  const rows = await db
    .select({
      id: developerApps.id,
      status: developerApps.status,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, developerAppId))
    .limit(1);
  return rows[0] ?? null;
}

async function verifyClearinghouseBalance(
  authorization: string,
): Promise<void> {
  const balanceUrl = process.env.CLEARINGHOUSE_BALANCE_URL?.trim();
  if (!balanceUrl) {
    return;
  }

  const response = await fetch(balanceUrl, {
    method: "GET",
    headers: { Authorization: authorization },
  });
  if (response.status === 401 || response.status === 403) {
    throw new PmtHouseError("clearinghouse rejected token", {
      status: 403,
      code: "clearinghouse_unauthorized",
    });
  }
  if (!response.ok) {
    throw new PmtHouseError("clearinghouse balance check failed", {
      status: 503,
      code: "clearinghouse_unavailable",
    });
  }

  const body = (await response.json()) as ClearinghouseBalanceBody;
  const balance = body.balance;
  if (!balance) {
    return;
  }
  if (balance.hasAccess === false) {
    throw new PmtHouseError("insufficient balance", {
      status: 402,
      code: "insufficient_balance",
    });
  }
  const remaining = balance.remainingUsdMicros ?? balance.balanceUsdMicros;
  if (remaining !== undefined && BigInt(remaining) <= 0n) {
    throw new PmtHouseError("insufficient balance", {
      status: 402,
      code: "insufficient_balance",
    });
  }
}

/**
 * Platform policy after JWT verification: app status, OpenMeter allowance, optional clearinghouse.
 */
export async function runSignerWebhookPlatformGating(
  context: WebhookAuthorizeContext,
): Promise<void> {
  const { identity, authorization } = context;
  const publicClientId = identity.client_id.trim();
  const usageSubject = identity.usage_subject.trim();
  if (!publicClientId || !usageSubject) {
    throw new PmtHouseError("JWT missing client or subject", {
      status: 403,
      code: "invalid_identity",
    });
  }

  const app = await resolveDeveloperApp(publicClientId);
  if (!app) {
    throw new PmtHouseError("application not found", {
      status: 403,
      code: "app_not_found",
    });
  }
  if (app.status !== "approved") {
    throw new PmtHouseError("application is not approved", {
      status: 403,
      code: "app_not_approved",
    });
  }

  const allowance = await getTrialCreditBalance({
    clientId: app.id,
    externalUserId: usageSubject,
  });
  if (allowance && !allowance.hasAccess) {
    throw new PmtHouseError("starter allowance exhausted", {
      status: 402,
      code: "trial_credits_exhausted",
    });
  }

  await verifyClearinghouseBalance(authorization);
}
