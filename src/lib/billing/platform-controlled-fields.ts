/**
 * Billing fields that protect PymtHouse rather than configure the Builder's app.
 *
 * `applicationFeeBps` is the platform's share of Connect payments and
 * `endUserCap` is the cost-rail guard against unbounded network spend. Each one
 * constrains the app owner, so neither may be set on the owner path — only by a
 * platform admin. See docs/adr-owner-vs-app-billing.md.
 */
export const PLATFORM_CONTROLLED_BILLING_FIELDS = [
  "applicationFeeBps",
  "endUserCap",
] as const;

export type PlatformControlledBillingField =
  (typeof PLATFORM_CONTROLLED_BILLING_FIELDS)[number];

/** Platform-controlled fields present in a PATCH body, in declaration order. */
export function platformControlledFieldsInBody(
  body: Record<string, unknown>,
): PlatformControlledBillingField[] {
  return PLATFORM_CONTROLLED_BILLING_FIELDS.filter(
    (field) => body[field] !== undefined,
  );
}

/** Message for a non-admin attempting to set platform-controlled fields. */
export function platformControlledFieldsError(
  fields: readonly string[],
): string {
  const subject = fields.join(" and ");
  const verb = fields.length === 1 ? "is" : "are";
  return `${subject} ${verb} set by PymtHouse and cannot be changed here. Contact support to request a change.`;
}
