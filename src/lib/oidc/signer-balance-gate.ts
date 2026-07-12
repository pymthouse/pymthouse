import type {
  BalanceCheck,
  UsageIdentity,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createBalanceGate } from "@pymthouse/clearinghouse-identity-webhook/balance-gate";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  effectiveBalanceUsdMicrosForGate,
  resolveAllowanceAccessForAppUser,
} from "@/lib/openmeter/allowance-access";

const DEFAULT_REAUTH_TTL_SECONDS = 60;

function resolveReauthTtlSeconds(): number {
  const raw = process.env.SIGNER_BALANCE_REAUTH_TTL_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_REAUTH_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REAUTH_TTL_SECONDS;
  }
  return parsed;
}

/**
 * Effective included-usage / paid-subscription access for a verified signer
 * identity. Returns micros for createBalanceGate (positive sentinel when paid
 * or plan-included access remains without a credits ledger balance).
 */
async function readIdentityBalanceUsdMicros(
  identity: UsageIdentity,
): Promise<string | null> {
  const snapshot = await resolveAllowanceAccessForAppUser({
    clientId: identity.client_id,
    externalUserId: identity.usage_subject,
  });
  return effectiveBalanceUsdMicrosForGate(snapshot);
}

/**
 * Build the live balance gate for the remote-signer webhook. Returns undefined
 * when hosted billing is not configured, so self-hosted / metering-off
 * deployments authorize on identity alone (matching the mint gate's behavior).
 */
export function buildSignerBalanceCheck(): BalanceCheck | undefined {
  if (!isHostedAdminClientAvailable()) {
    return undefined;
  }
  return createBalanceGate({
    getBalanceUsdMicros: (identity) => readIdentityBalanceUsdMicros(identity),
    reauthTtlSeconds: resolveReauthTtlSeconds(),
    failClosed: true,
    onError: (err) => {
      console.warn(
        "[remote-signer] live balance check failed:",
        err instanceof Error ? err.message : String(err),
      );
    },
  });
}
