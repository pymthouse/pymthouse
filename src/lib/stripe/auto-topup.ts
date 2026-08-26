/**
 * Optional merchant end-user prepaid auto-reload.
 *
 * When live spendable hits $0, mint and the remote-signer live gate charge the
 * saved Connect card before falling back to soft-negative overage. Users with
 * a card are overage-eligible, so reload must run first or it never fires.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appUsers } from "@/db/schema";
import { createAsyncTtlCache } from "@/lib/async-ttl-cache";
import { resolveAppUserExternalIdFromCustomerKey } from "@/lib/billing/end-users";
import { formatUsdMicrosForDisplay } from "@/lib/billing/pay-per-use-threshold";
import { listAppUserPaymentMethods } from "@/lib/openmeter/app-user-payment-method";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { getProviderApp } from "@/lib/provider-apps";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  createConnectedOffSessionPaymentIntent,
} from "@/lib/stripe/connect-accounts";
import {
  LEGACY_AUTO_TOP_UP_METADATA_FLAG,
  legacyAutoTopUpGrantIdempotencyKey,
} from "@/lib/stripe/legacy-auto-topup";
import {
  appStripeLivemode,
  getAppUserStripeCustomer,
} from "@/lib/stripe/merchant-connect";
import {
  parseTopUpAmountUsd,
  TOP_UP_MIN_USD_MICROS,
} from "@/lib/stripe/topup-checkout";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

export const DEFAULT_AUTO_TOP_UP_USD_MICROS = 10_000_000n; // $10.00

const AUTO_TOP_UP_SINGLEFLIGHT_TTL_SECONDS = 45;
const STRIPE_IDEMPOTENCY_BUCKET_MS = 45_000;

export type AutoTopUpPrefs = {
  enabled: boolean;
  amountUsd: string | null;
};

export type AutoTopUpResult =
  | { status: "skipped"; reason: string }
  | { status: "charged"; paymentIntentId: string; grantedUsdMicros: string }
  | { status: "failed"; reason: string };

type TryAutoTopUpFn = (input: {
  publicClientId: string;
  externalUserId: string;
}) => Promise<AutoTopUpResult>;

/** Injectable collaborators for unit tests (Stripe / OM / DB stay out of process). */
export type AutoTopUpRuntime = {
  getProviderApp: (publicClientId: string) => Promise<{ id?: string } | null>;
  loadPrefs: (input: {
    appId: string;
    externalUserId: string;
  }) => Promise<AutoTopUpPrefs>;
  getAppBillingConfig: (developerAppId: string) => Promise<{
    billingMode?: string | null;
    stripeConnectedAccountId?: string | null;
    defaultCurrency?: string | null;
    applicationFeeBps?: number | null;
    stripeLivemode?: boolean | null;
  } | null>;
  listAppUserPaymentMethods: (input: {
    clientId: string;
    externalUserId: string;
  }) => Promise<Array<{ id?: string; isDefault?: boolean }>>;
  getAppUserStripeCustomer: (input: {
    clientId: string;
    externalUserId: string;
    stripeConnectedAccountId: string;
  }) => Promise<{
    stripeCustomerId?: string | null;
    stripeConnectedAccountId?: string | null;
  } | null>;
  createConnectedOffSessionPaymentIntent: (
    input: Parameters<typeof createConnectedOffSessionPaymentIntent>[0],
  ) => ReturnType<typeof createConnectedOffSessionPaymentIntent>;
  grantAllowanceUsdMicros: (
    input: Parameters<typeof grantAllowanceUsdMicros>[0],
  ) => ReturnType<typeof grantAllowanceUsdMicros>;
  resolveAppUserExternalId: (input: {
    developerAppId: string;
    externalUserId: string;
  }) => Promise<string>;
};

let tryAutoTopUpForTests: TryAutoTopUpFn | null = null;
let autoTopUpRuntimeForTests: AutoTopUpRuntime | null = null;

export function __setTryAutoTopUpIfEnabledForTests(
  fn: TryAutoTopUpFn | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__setTryAutoTopUpIfEnabledForTests is only available in test",
    );
  }
  tryAutoTopUpForTests = fn;
}

/**
 * Test-only override for the charge path (provider app, prefs, Stripe, grant).
 * Always `null` (inert) outside NODE_ENV=test.
 */
export function __setAutoTopUpRuntimeForTests(
  runtime: AutoTopUpRuntime | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__setAutoTopUpRuntimeForTests is only available in test",
    );
  }
  autoTopUpRuntimeForTests = runtime;
}

function autoTopUpRuntime(): AutoTopUpRuntime {
  const defaults: AutoTopUpRuntime = {
    getProviderApp,
    loadPrefs: loadAppUserAutoTopUpPrefs,
    getAppBillingConfig,
    listAppUserPaymentMethods,
    getAppUserStripeCustomer,
    createConnectedOffSessionPaymentIntent,
    grantAllowanceUsdMicros,
    resolveAppUserExternalId: ({ externalUserId }) =>
      resolveAppUserExternalIdFromCustomerKey(externalUserId),
  };
  if (!autoTopUpRuntimeForTests) {
    return defaults;
  }
  return {
    ...defaults,
    ...autoTopUpRuntimeForTests,
  };
}

const autoTopUpFlight = createAsyncTtlCache<AutoTopUpResult>({
  ttlSeconds: AUTO_TOP_UP_SINGLEFLIGHT_TTL_SECONDS,
});

export function serializeAutoTopUpPrefs(input: {
  enabled: boolean;
  amountUsdMicros: string | null | undefined;
}): AutoTopUpPrefs {
  const raw = input.amountUsdMicros?.trim() || "";
  let amountUsd: string | null = null;
  if (raw) {
    try {
      const micros = BigInt(raw);
      if (micros >= TOP_UP_MIN_USD_MICROS) {
        amountUsd = formatUsdMicrosForDisplay(raw);
      }
    } catch {
      amountUsd = null;
    }
  }
  return {
    enabled: input.enabled,
    amountUsd,
  };
}

export function parseAutoTopUpPatch(body: Record<string, unknown>):
  | { ok: true; enabled: boolean; amountUsdMicros: bigint | undefined }
  | { ok: false; error: string } {
  if (typeof body.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (body.amountUsd === undefined) {
    return { ok: true, enabled: body.enabled, amountUsdMicros: undefined };
  }
  const amount = parseTopUpAmountUsd(body.amountUsd);
  if (!amount.ok) {
    return { ok: false, error: amount.error };
  }
  return {
    ok: true,
    enabled: body.enabled,
    amountUsdMicros: amount.amountUsdMicros,
  };
}

export async function loadAppUserAutoTopUpPrefs(input: {
  appId: string;
  externalUserId: string;
}): Promise<AutoTopUpPrefs> {
  const rows = await db
    .select({
      autoTopUpEnabled: appUsers.autoTopUpEnabled,
      autoTopUpUsdMicros: appUsers.autoTopUpUsdMicros,
    })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, input.appId),
        eq(appUsers.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return serializeAutoTopUpPrefs({
    enabled: Boolean(row?.autoTopUpEnabled),
    amountUsdMicros: row?.autoTopUpUsdMicros,
  });
}

export async function saveAppUserAutoTopUpPrefs(input: {
  appId: string;
  externalUserId: string;
  enabled: boolean;
  amountUsdMicros: bigint;
}): Promise<AutoTopUpPrefs> {
  await resolveOrCreateAppUser({
    clientId: input.appId,
    externalUserId: input.externalUserId,
  });
  await db
    .update(appUsers)
    .set({
      autoTopUpEnabled: input.enabled,
      autoTopUpUsdMicros: input.amountUsdMicros.toString(),
    })
    .where(
      and(
        eq(appUsers.clientId, input.appId),
        eq(appUsers.externalUserId, input.externalUserId),
      ),
    );
  return serializeAutoTopUpPrefs({
    enabled: input.enabled,
    amountUsdMicros: input.amountUsdMicros.toString(),
  });
}

function stripeIdempotencyKey(
  developerAppId: string,
  externalUserId: string,
): string {
  const bucket = Math.floor(Date.now() / STRIPE_IDEMPOTENCY_BUCKET_MS);
  return `autotopup-pi:${developerAppId}:${externalUserId}:${bucket}`;
}

async function executeEnabledAutoTopUp(input: {
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
  amountUsdMicros: bigint;
}): Promise<AutoTopUpResult> {
  const runtime = autoTopUpRuntime();
  const billingConfig = await runtime.getAppBillingConfig(input.developerAppId);
  if (billingConfig?.billingMode !== "merchant") {
    return { status: "skipped", reason: "not_merchant" };
  }
  const accountId = billingConfig.stripeConnectedAccountId?.trim() || "";
  if (!accountId) {
    return { status: "skipped", reason: "connect_not_ready" };
  }
  const livemode = appStripeLivemode(billingConfig);

  const paymentMethods = await runtime.listAppUserPaymentMethods({
    clientId: input.developerAppId,
    externalUserId: input.externalUserId,
  });
  const defaultPm = paymentMethods.find((pm) => pm.isDefault);
  if (!defaultPm?.id) {
    return { status: "skipped", reason: "no_payment_method" };
  }

  const customer = await runtime.getAppUserStripeCustomer({
    clientId: input.developerAppId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: accountId,
  });
  const stripeCustomerId = customer?.stripeCustomerId?.trim() || "";
  // The lookup is already scoped to this plane's account, but the resolver is
  // injectable and this path charges a card — re-check before moving money.
  if (!stripeCustomerId || customer?.stripeConnectedAccountId !== accountId) {
    return { status: "skipped", reason: "no_stripe_customer" };
  }

  const amountCents = Number(input.amountUsdMicros / 10_000n);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { status: "skipped", reason: "invalid_amount" };
  }

  let pi: { id: string; status: string };
  try {
    pi = await runtime.createConnectedOffSessionPaymentIntent({
      accountId,
      customerId: stripeCustomerId,
      paymentMethodId: defaultPm.id,
      amountCents,
      currency: (billingConfig.defaultCurrency ?? "usd").toLowerCase(),
      applicationFeeBps: billingConfig.applicationFeeBps ?? 0,
      livemode,
      idempotencyKey: stripeIdempotencyKey(
        input.developerAppId,
        input.externalUserId,
      ),
      metadata: {
        [LEGACY_AUTO_TOP_UP_METADATA_FLAG]: "1",
        client_id: input.publicClientId,
        external_user_id: input.externalUserId,
      },
    });
  } catch (err) {
    console.warn(
      "[auto-topup] PaymentIntent failed",
      sanitizeForLog(input.publicClientId),
      sanitizeForLog(input.externalUserId),
      sanitizeForLog(err),
    );
    return { status: "failed", reason: "stripe_charge_failed" };
  }

  if (pi.status !== "succeeded") {
    return { status: "failed", reason: `stripe_status_${pi.status}` };
  }

  try {
    await runtime.grantAllowanceUsdMicros({
      clientId: input.publicClientId,
      externalUserId: input.externalUserId,
      amountUsdMicros: input.amountUsdMicros,
      source: "topup",
      idempotencyKey: legacyAutoTopUpGrantIdempotencyKey(pi.id),
    });
  } catch (err) {
    console.warn(
      "[auto-topup] grant failed after charge; webhook will retry",
      sanitizeForLog(pi.id),
      sanitizeForLog(err),
    );
    // Card was captured. Treat as charged so the gate does not 483; webhook
    // settles the grant with the same idempotency key.
  }

  return {
    status: "charged",
    paymentIntentId: pi.id,
    grantedUsdMicros: input.amountUsdMicros.toString(),
  };
}

/**
 * Charge the saved card and grant credits when auto-top-up is enabled.
 * Concurrent calls for the same user share one PaymentIntent.
 */
export async function tryAutoTopUpIfEnabled(input: {
  publicClientId: string;
  externalUserId: string;
}): Promise<AutoTopUpResult> {
  if (tryAutoTopUpForTests) {
    return tryAutoTopUpForTests(input);
  }

  const publicClientId = input.publicClientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!publicClientId || !externalUserId) {
    return logAutoTopUpOutcome(publicClientId, externalUserId, {
      status: "skipped",
      reason: "missing_identity",
    });
  }

  const runtime = autoTopUpRuntime();
  return autoTopUpFlight.get(
    `${publicClientId}\u0000${externalUserId}`,
    async () => {
      const app = await runtime.getProviderApp(publicClientId);
      if (!app?.id) {
        return logAutoTopUpOutcome(publicClientId, externalUserId, {
          status: "skipped",
          reason: "app_not_found",
        });
      }
      const resolvedExternalUserId = await runtime.resolveAppUserExternalId({
        developerAppId: app.id,
        externalUserId,
      });
      const prefs = await runtime.loadPrefs({
        appId: app.id,
        externalUserId: resolvedExternalUserId,
      });
      if (!prefs.enabled) {
        return logAutoTopUpOutcome(publicClientId, resolvedExternalUserId, {
          status: "skipped",
          reason: "disabled",
        });
      }
      let amountUsdMicros = DEFAULT_AUTO_TOP_UP_USD_MICROS;
      if (prefs.amountUsd) {
        const parsed = parseTopUpAmountUsd(prefs.amountUsd);
        if (parsed.ok) {
          amountUsdMicros = parsed.amountUsdMicros;
        }
      }
      return logAutoTopUpOutcome(
        publicClientId,
        resolvedExternalUserId,
        await executeEnabledAutoTopUp({
          publicClientId,
          developerAppId: app.id,
          externalUserId: resolvedExternalUserId,
          amountUsdMicros,
        }),
      );
    },
  );
}

function logAutoTopUpOutcome(
  publicClientId: string,
  externalUserId: string,
  result: AutoTopUpResult,
): AutoTopUpResult {
  if (result.status === "charged") {
    return result;
  }
  console.info(
    "[auto-topup]",
    result.status,
    result.reason,
    sanitizeForLog(publicClientId),
    sanitizeForLog(externalUserId),
  );
  return result;
}
