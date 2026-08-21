/**
 * Policy for end-user OpenMeter customer cutover
 * (`app_…:externalUserId` → `eu_{end_users.id}`).
 *
 * Merchant payers live on `eu_…`. Owner_rollup payers live on the owner wallet;
 * `eu_…` is still ensured as the actor customer, but prepaid must not move onto
 * `eu_…` or it becomes stranded.
 */

export type BillingMode = "owner_rollup" | "merchant";

export type EndUserTransferTarget = "eu" | "owner" | "none";

export type EndUserMigratePolicy = {
  transferTarget: EndUserTransferTarget;
  cancelLegacy: boolean;
  provisionMerchantStarter: boolean;
};

/**
 * Resolve migrate actions for one app.
 *
 * `--full` applies the production cutover policy from billing mode and ignores
 * the granular transfer/cancel/provision flags.
 */
export function resolveEndUserMigratePolicy(input: {
  billingMode: BillingMode;
  full: boolean;
  transferBalances: boolean;
  cancelLegacy: boolean;
  provisionMerchant: boolean;
}): EndUserMigratePolicy {
  if (input.full) {
    if (input.billingMode === "merchant") {
      return {
        transferTarget: "eu",
        cancelLegacy: true,
        provisionMerchantStarter: true,
      };
    }
    return {
      transferTarget: "owner",
      cancelLegacy: true,
      provisionMerchantStarter: false,
    };
  }

  if (input.billingMode === "owner_rollup" && input.transferBalances) {
    throw new Error(
      "owner_rollup apps must not transfer legacy prepaid onto eu_… " +
        "(that wallet is not the payer). Use --full to move remaining " +
        "credits onto the owner wallet, or omit --transfer-balances.",
    );
  }

  return {
    transferTarget: input.transferBalances ? "eu" : "none",
    cancelLegacy: input.cancelLegacy,
    provisionMerchantStarter:
      input.billingMode === "merchant" && input.provisionMerchant,
  };
}
