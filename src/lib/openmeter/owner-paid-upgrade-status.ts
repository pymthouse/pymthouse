export type OwnerPaidUpgradeErrorCode =
  | "payment_method_required"
  | "openmeter_unavailable"
  | "no_subscription"
  | "upgrade_failed";

/** Map Owner Paid upgrade error codes to HTTP status codes. */
export function ownerPaidUpgradeHttpStatus(
  code: OwnerPaidUpgradeErrorCode,
): number {
  switch (code) {
    case "payment_method_required":
      return 402;
    case "openmeter_unavailable":
      return 503;
    case "no_subscription":
      return 404;
    default:
      return 400;
  }
}
