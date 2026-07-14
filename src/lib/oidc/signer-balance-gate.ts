import type {
  BalanceCheck,
  UsageIdentity,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createBalanceGate } from "@pymthouse/clearinghouse-identity-webhook/balance-gate";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { getSpendableUsdMicros } from "@/lib/openmeter/spendable-allowance";

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
 * Spendable allowance for a verified signer identity: prepaid credits plus any
 * remaining plan usage discount for the current cycle.
 */
async function readIdentityBalanceUsdMicros(
  identity: UsageIdentity,
): Promise<string | null> {
  return getSpendableUsdMicros({
    clientId: identity.client_id,
    externalUserId: identity.usage_subject,
  });
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
