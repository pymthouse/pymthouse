import { NextResponse } from "next/server";

import {
  authorizeOwnerWalletM2m,
  type OwnerWalletM2mAccess,
} from "@/lib/billing/owner-wallet-m2m-auth";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
  type WalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";

export type WalletRouteContext = OwnerWalletM2mAccess & {
  target: WalletBillingTarget;
};

export type WalletRouteContextResult =
  | { ok: true; context: WalletRouteContext }
  | { ok: false; response: NextResponse };

/**
 * Shared preamble for `/api/v1/apps/{clientId}/billing/wallet/*`: authorize the
 * Builder M2M caller, then resolve whose wallet the request acts on.
 *
 * Failures come back as the exact response the route should return — 404 when
 * authorization fails (app existence is never leaked) and 400 when the billing
 * mode needs an `externalUserId` the caller did not send.
 */
export async function resolveWalletRouteContext(input: {
  request: Request;
  /** Public OAuth client id from the route path. */
  clientId: string;
  /** Raw `externalUserId` from the query string or JSON body. */
  externalUserId?: unknown;
}): Promise<WalletRouteContextResult> {
  const access = await authorizeOwnerWalletM2m(input.request, input.clientId);
  if (!access) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId: readOptionalExternalUserId(input.externalUserId),
  });
  if (!billingTarget.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: billingTarget.error },
        { status: billingTarget.status },
      ),
    };
  }

  return { ok: true, context: { ...access, target: billingTarget.target } };
}
