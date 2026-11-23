/**
 * Controlled value for the identity plan <select> in IdentityBillingPanel.
 *
 * Soft-navigating between `/identities/[externalUserId]` routes can keep the
 * client panel mounted. Seeding the dropdown only when the selection is empty
 * then leaves identity A's plan selected on identity B, and Apply POSTs that
 * planId to B's `/subscription/change`. Always derive from the live plan for
 * the identity currently on screen (re-run when appId / externalUserId /
 * livePlanId change; user drafts stay until livePlanId updates because the
 * effect does not re-fire on select-only changes).
 */
export function identityPlanSelectValue(
  livePlanId: string | null | undefined,
): string {
  if (typeof livePlanId !== "string") return "";
  return livePlanId.trim();
}

/** React key so the billing panel remounts when the viewed identity changes. */
export function identityBillingPanelKey(
  appId: string,
  externalUserId: string,
): string {
  return `${appId}:${externalUserId}`;
}
