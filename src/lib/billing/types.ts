/** Stable Builder API billing contracts — shared types from @pymthouse/builder-sdk. */

export type {
  AllowancePolicy,
  BillingSyncState,
  BillingSyncStatus,
  CapabilityPriceRule,
  SignedTicketIngestInput,
  SignedTicketIngestResult,
  SignerRoutingConfig,
  UserAllowanceGrantInput,
} from "@pymthouse/builder-sdk";

import type {
  BillingProduct as SdkBillingProduct,
  GrantSource as SdkGrantSource,
} from "@pymthouse/builder-sdk";

/** Includes MoonPay on-ramp until @pymthouse/builder-sdk publishes `onramp`. */
export type GrantSource = SdkGrantSource | "onramp";

/** PymtHouse plan DTO extends the SDK contract with discovery fields. */
export type BillingProduct = SdkBillingProduct & {
  discoveryProfileId?: string | null;
  discoveryPolicy?: unknown;
};
