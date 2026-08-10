import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";

export type WalletBillingTarget =
  | { mode: "owner_rollup"; ownerUserId: string }
  | { mode: "merchant"; externalUserId: string };

export type WalletBillingTargetResult =
  | { ok: true; target: WalletBillingTarget }
  | { ok: false; status: 400; error: string };

/** Trim a query/body `externalUserId` — empty / non-string → null. */
export function readOptionalExternalUserId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Resolve who the prepaid wallet surface credits for this app.
 *
 * - `billingMode === "merchant"` → require `externalUserId` (end-user OM customer)
 * - otherwise (`owner_rollup` / missing config) → app owner wallet; `externalUserId`
 *   is ignored as a grant target
 */
export async function resolveWalletBillingTarget(input: {
  /** `developer_apps.id` — `app_billing_config.client_id` FK. */
  appId: string;
  ownerUserId: string;
  externalUserId?: string | null;
}): Promise<WalletBillingTargetResult> {
  const config = await getAppBillingConfig(input.appId);
  if (config?.billingMode === "merchant") {
    const externalUserId = input.externalUserId?.trim() || "";
    if (!externalUserId) {
      return {
        ok: false,
        status: 400,
        error: "externalUserId is required when billingMode is merchant",
      };
    }
    return { ok: true, target: { mode: "merchant", externalUserId } };
  }
  return {
    ok: true,
    target: { mode: "owner_rollup", ownerUserId: input.ownerUserId },
  };
}
