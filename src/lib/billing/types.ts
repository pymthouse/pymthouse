/** Stable Builder API billing contracts — shared types from @pymthouse/builder-sdk. */

export type {
  AllowancePolicy,
  BillingSyncState,
  BillingSyncStatus,
  CapabilityPriceRule,
  GrantSource as SdkGrantSource,
  SignedTicketIngestInput,
  SignedTicketIngestResult,
  SignerRoutingConfig,
  UserAllowanceGrantInput,
} from "@pymthouse/builder-sdk";

import type { GrantSource as SdkGrantSource } from "@pymthouse/builder-sdk";

/** SDK grant sources plus on-chain deposit credits and x402 settlements. */
export type GrantSource = SdkGrantSource | "onchain_deposit" | "x402_settlement";

import type { BillingProduct as SdkBillingProduct } from "@pymthouse/builder-sdk";

/** PymtHouse plan DTO extends the SDK contract with discovery fields. */
export type BillingProduct = SdkBillingProduct & {
  discoveryProfileId?: string | null;
  discoveryPolicy?: unknown;
};
