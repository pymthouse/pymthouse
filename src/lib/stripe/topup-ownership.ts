/**
 * Ownership check for prepaid top-up settlement: the `client_id` carried in the
 * Checkout session metadata must belong to the `owner_user_id` in the same
 * metadata, so a forged session cannot credit another owner's wallet.
 *
 * Lives outside the webhook route because a Next.js route module may only
 * export route fields (`POST`, `runtime`, …) — a test seam exported from
 * `route.ts` fails `next build`'s route type check.
 */
import { listOwnedPublicClientIds } from "@/lib/openmeter/customers";

export type TopUpClientOwnedByOwner = (
  clientId: string,
  ownerUserId: string,
) => Promise<boolean>;

let topUpClientOwnedByOwnerForTests: TopUpClientOwnedByOwner | null = null;

/**
 * Test-only override for top-up ownership checks (Stripe webhook route).
 * Always `null` (inert) outside NODE_ENV=test.
 */
export function __setTopUpClientOwnedByOwnerForTests(
  fn: TopUpClientOwnedByOwner | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setTopUpClientOwnedByOwnerForTests is only available in test");
  }
  topUpClientOwnedByOwnerForTests = fn;
}

export async function topUpClientOwnedByOwner(
  clientId: string,
  ownerUserId: string,
): Promise<boolean> {
  if (topUpClientOwnedByOwnerForTests) {
    return topUpClientOwnedByOwnerForTests(clientId, ownerUserId);
  }
  const owned = await listOwnedPublicClientIds(ownerUserId);
  return owned.includes(clientId);
}
