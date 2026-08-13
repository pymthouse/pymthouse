/**
 * Client for settlement's `POST /requests/collect` — "raise this customer's
 * pending gathering lines now."
 *
 * Settlement owns the actual raise (the OpenMeter `invoicePendingLines`
 * call) so that concurrent raise attempts for one customer serialize through
 * its per-customer Kafka lane instead of racing pymthouse's own synchronous
 * calls into "an active realization run already exists." pymthouse still
 * decides *whether* a customer is due (soft-negative ceiling, lead window,
 * force); this only asks settlement to execute that decision, and does not
 * wait around for the result — see {@link requestSettlementCollect}.
 */
import { randomUUID } from "node:crypto";

import { sanitizeForLog } from "@/lib/sanitize-for-log";

export type SettlementCollectRequest = {
  clientId: string;
  externalUserId: string;
  customerId: string;
  /** Explicit collect-now vs. the automatic mid-cycle trigger; forwarded so
   * settlement knows whether to push the raised invoice past the collection
   * period and approval delay (see settlement's HandleCollectRequest). */
  force: boolean;
};

export type SettlementCollectOutcome = "queued" | "unavailable" | "error";

function settlementCollectConfig(): { url: string; secret: string } | null {
  const url = process.env.SETTLEMENT_COLLECT_REQUEST_URL?.trim();
  const secret = process.env.SETTLEMENT_COLLECT_REQUEST_SECRET?.trim();
  if (!url || !secret) return null;
  return { url, secret };
}

/** Whether settlement's collect endpoint is configured in this environment. */
export function isSettlementCollectConfigured(): boolean {
  return settlementCollectConfig() !== null;
}

/**
 * Ask settlement to raise `customerId`'s pending gathering lines now.
 *
 * This is fire-and-forget from the caller's perspective: a `"queued"`
 * outcome means settlement's doorman accepted the request onto its Kafka
 * lane, not that an invoice was created. The real outcome shows up later
 * through the normal billing-state read (unbilled debt clears, or a new
 * invoice appears in billing history) — there is deliberately no separate
 * polling path added for this; `GET /billing/state` already exists and
 * already gets read after every mutating call.
 */
export async function requestSettlementCollect(
  input: SettlementCollectRequest,
): Promise<SettlementCollectOutcome> {
  const config = settlementCollectConfig();
  if (!config) {
    return "unavailable";
  }

  const requestId = randomUUID();
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.secret}`,
      },
      body: JSON.stringify({
        clientId: input.clientId,
        externalUserId: input.externalUserId,
        customerId: input.customerId,
        force: input.force,
        requestId,
      }),
      // The doorman only verifies and publishes to Kafka — bounding this
      // tightly is what keeps a forced collect-now off pymthouse's slow
      // synchronous path, which is the whole reason this call exists.
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        "[settlement-collect] request rejected",
        response.status,
        sanitizeForLog(body.slice(0, 500)),
      );
      return "error";
    }
    return "queued";
  } catch (err) {
    console.warn(
      "[settlement-collect] request failed",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return "error";
  }
}
