/**
 * The canonical billing state contract.
 *
 * One object answers the three questions an integrator has: can this subject
 * spend right now, how much room is left, and what happens next. Every surface
 * — the state route, the wallet response, the mint/signer rejections, the
 * dashboard and the admin app — reads from this vocabulary so a rejection and a
 * read never disagree.
 *
 * Client-safe: no DB or Node imports, so the dashboard and the plan dialog can
 * render the same copy the API returns. Data fetching lives in
 * `billing-state-read.ts`.
 */
import {
  MIN_INVOICE_USD_MICROS,
  MIN_SOFT_NEGATIVE_USD_MICROS,
  effectiveInvoiceLeadUsdMicros,
  effectiveSoftNegativeUsdMicros,
  parseSoftNegativeUsdMicrosInput,
} from "@/lib/billing/auto-topup-settings";
import { formatUsdMicrosForDisplay } from "@/lib/billing/pay-per-use-threshold";

/**
 * Money is always an object. The sibling `xUsdMicros` / `xUsd` pairs that used
 * to sprawl across billing responses lost their currency on the wire even
 * though `app_billing_config.default_currency` drives settlement.
 */
export type Money = {
  usdMicros: string;
  usd: string;
  currency: string;
};

export type BillingStatus = "active" | "overage" | "at_risk" | "blocked";

/** Shared between this resource and the mint / signer rejection bodies. */
export type BillingReason =
  | "no_payment_method"
  | "overage_not_available"
  | "debt_ceiling_reached"
  | "billing_unavailable";

/**
 * Terse wire messages per reason, for transports whose only free-text slot has
 * to carry the meaning. `no_payment_method` keeps the long-standing
 * "Payment method required" wording so existing clients still match on it.
 */
export const BILLING_REASON_MESSAGE: Record<BillingReason, string> = {
  no_payment_method: "Payment method required",
  overage_not_available: "Add funds to continue",
  debt_ceiling_reached: "Overage limit reached while payment is collected",
  billing_unavailable: "Billing allowance could not be confirmed",
};

export type BillingNextAction =
  | "none"
  | "awaiting_settlement"
  | "add_payment_method"
  | "add_funds";

/** Whether unbilled debt is a real invoice total or the meter-sum fallback. */
export type DebtSource = "gathering_invoice" | "meter_estimate" | "unavailable";

export type BillingCollector = "settlement_connect" | "openmeter_stripe";

export type BillingState = {
  asOf: string;
  subject: {
    type: "end_user" | "owner";
    externalUserId: string | null;
    billingMode: "merchant" | "owner_rollup";
  };
  status: BillingStatus;
  canSpend: boolean;
  reason: BillingReason | null;
  funding: {
    prepaid: Money;
    included: Money;
    spendable: Money;
    overage: {
      eligible: boolean;
      ceiling: Money;
      unbilledDebt: Money | null;
      remaining: Money | null;
      utilizationBps: number | null;
      debtSource: DebtSource;
    };
  };
  collection: {
    mode: "progressive_invoice";
    collector: BillingCollector;
    paymentMethod: {
      hasDefault: boolean | null;
      brand: string | null;
      last4: string | null;
    };
    nextAction: BillingNextAction;
    leadThreshold: Money;
    minimumCharge: Money;
    cycle: string;
    collectionInterval: string;
    lastRaisedAt: string | null;
    nextRaiseEligibleAt: string | null;
  };
  explain: {
    headline: string;
    detail: string;
    docsUrl: string;
  };
};

const DOCS_URL = "https://docs.pymthouse.com/billing/pay-as-you-go";

export function money(usdMicros: bigint, currency: string): Money {
  const clamped = usdMicros > 0n ? usdMicros : 0n;
  return {
    usdMicros: clamped.toString(),
    usd: formatUsdMicrosForDisplay(clamped.toString()),
    currency,
  };
}

export type BillingStateInput = {
  asOf?: Date;
  currency: string;
  subject: BillingState["subject"];
  prepaidUsdMicros: bigint;
  includedRemainingUsdMicros: bigint;
  overageEligible: boolean;
  /** 0 means no ceiling: overage eligibility alone unlocks spend past $0. */
  softNegativeUsdMicros: bigint;
  /** Null when debt could not be read. */
  unbilledDebtUsdMicros: bigint | null;
  debtSource: DebtSource;
  leadUsdMicros: bigint;
  minimumChargeUsdMicros: bigint;
  collector: BillingCollector;
  paymentMethod: {
    hasDefault: boolean | null;
    brand?: string | null;
    last4?: string | null;
  };
  /** False when OpenMeter could not be reached — we cannot confirm allowance. */
  billingAvailable: boolean;
  cycle: string;
  collectionInterval: string;
  lastRaisedAt?: string | null;
  nextRaiseEligibleAt?: string | null;
};

type Posture = {
  status: BillingStatus;
  canSpend: boolean;
  reason: BillingReason | null;
};

function resolvePosture(input: {
  billingAvailable: boolean;
  spendableUsdMicros: bigint;
  overageEligible: boolean;
  hasDefaultPaymentMethod: boolean | null;
  softNegativeUsdMicros: bigint;
  unbilledDebtUsdMicros: bigint | null;
  leadUsdMicros: bigint;
}): Posture {
  if (!input.billingAvailable) {
    return {
      status: "blocked",
      canSpend: false,
      reason: "billing_unavailable",
    };
  }
  if (input.spendableUsdMicros > 0n) {
    return { status: "active", canSpend: true, reason: null };
  }
  if (!input.overageEligible) {
    return {
      status: "blocked",
      canSpend: false,
      reason:
        input.hasDefaultPaymentMethod === false
          ? "no_payment_method"
          : "overage_not_available",
    };
  }
  // No ceiling configured: overage alone carries spend past prepaid zero.
  if (input.softNegativeUsdMicros <= 0n) {
    return { status: "overage", canSpend: true, reason: null };
  }
  // Debt unknown. The gate does its own authoritative lookup, so read surfaces
  // report the permissive posture rather than inventing a block.
  if (input.unbilledDebtUsdMicros == null) {
    return { status: "overage", canSpend: true, reason: null };
  }
  if (input.unbilledDebtUsdMicros >= input.softNegativeUsdMicros) {
    return {
      status: "blocked",
      canSpend: false,
      reason: "debt_ceiling_reached",
    };
  }
  const remaining = input.softNegativeUsdMicros - input.unbilledDebtUsdMicros;
  // at_risk is exactly the invoice trigger's lead window, so the warning a
  // customer sees is the same condition that raises the invoice.
  if (input.leadUsdMicros > 0n && remaining <= input.leadUsdMicros) {
    return { status: "at_risk", canSpend: true, reason: null };
  }
  return { status: "overage", canSpend: true, reason: null };
}

function resolveNextAction(posture: Posture): BillingNextAction {
  if (posture.status === "at_risk") {
    return "awaiting_settlement";
  }
  if (posture.status !== "blocked") {
    return "none";
  }
  switch (posture.reason) {
    case "no_payment_method":
      return "add_payment_method";
    case "overage_not_available":
      return "add_funds";
    case "debt_ceiling_reached":
      return "awaiting_settlement";
    default:
      return "none";
  }
}

/**
 * Customer-facing copy for a spend posture. "Soft negative" and other ledger
 * terms never appear here; the ceiling reads as a spending buffer.
 */
export function explainBillingState(input: {
  status: BillingStatus;
  reason: BillingReason | null;
  spendable: Money;
  ceiling: Money;
  remaining: Money | null;
}): BillingState["explain"] {
  const ceilingIsSet = input.ceiling.usdMicros !== "0";
  switch (input.status) {
    case "active":
      return {
        headline: "Credits available",
        detail: `You have $${input.spendable.usd} of credit remaining. Usage draws down credits first.`,
        docsUrl: DOCS_URL,
      };
    case "overage":
      return {
        headline: "Usage is billed as it accrues",
        detail: ceilingIsSet
          ? `Credits are used up, so usage is now invoiced automatically as it accrues. You can accrue up to $${input.ceiling.usd} of unbilled usage while those invoices are collected.`
          : "Credits are used up, so usage is now invoiced automatically as it accrues.",
        docsUrl: DOCS_URL,
      };
    case "at_risk":
      return {
        headline: "Collecting recent usage",
        detail: `An invoice for your recent usage is being collected. $${input.remaining?.usd ?? "0.00"} of your $${input.ceiling.usd} spending buffer is left; requests keep working unless the buffer runs out first.`,
        docsUrl: DOCS_URL,
      };
    case "blocked":
      return {
        headline: "Requests are paused",
        detail: blockedDetail(input.reason, input.ceiling),
        docsUrl: DOCS_URL,
      };
  }
}

function blockedDetail(reason: BillingReason | null, ceiling: Money): string {
  switch (reason) {
    case "no_payment_method":
      return "Add a payment method to keep making requests. Usage past your credits is billed automatically once one is on file.";
    case "overage_not_available":
      return "Your credits are used up and this account cannot bill usage automatically. Add funds to resume.";
    case "debt_ceiling_reached":
      return `You have reached the $${ceiling.usd} spending buffer while payment for recent usage is still being collected. Requests resume as soon as that payment clears.`;
    case "billing_unavailable":
      return "Billing could not be confirmed right now, so requests are paused. This usually clears on its own.";
    default:
      return "Requests are paused.";
  }
}

/**
 * Worked example for the overage-limit field: what the number an operator is
 * typing means for their end users. Runs the same resolvers the runtime uses,
 * so the preview cannot drift from the behaviour it describes.
 */
export function previewOverageCeiling(
  softNegativeUsdMicros: string | null | undefined,
): { error: string | null; summary: string; bullets: string[] } {
  const parsed = parseSoftNegativeUsdMicrosInput(softNegativeUsdMicros ?? null);
  if (!parsed.ok) {
    return {
      error: `Enter $0 for no limit, or at least $${formatUsdMicrosForDisplay(MIN_SOFT_NEGATIVE_USD_MICROS.toString())}. Smaller limits lock users out before an invoice can be collected.`,
      summary: "",
      bullets: [],
    };
  }

  const ceiling = effectiveSoftNegativeUsdMicros(parsed.value);
  const summary = explainOverageCeiling(parsed.value);
  const minimum = formatUsdMicrosForDisplay(MIN_INVOICE_USD_MICROS.toString());
  const bullets: string[] = [];

  if (ceiling > 0n) {
    const lead = effectiveInvoiceLeadUsdMicros({
      storedUsdMicros: null,
      softNegativeUsdMicros: ceiling,
    });
    const buffer = ceiling > lead ? ceiling - lead : 0n;
    bullets.push(
      `An invoice goes out once a user has $${formatUsdMicrosForDisplay(lead.toString())} of unbilled usage, leaving $${formatUsdMicrosForDisplay(buffer.toString())} of buffer while it is collected.`,
    );
  } else {
    bullets.push(
      "No invoice is triggered by amount, so unbilled usage is only collected on the recurring sweep.",
    );
  }
  bullets.push(
    `Usage under $${minimum} is never invoiced — cards cannot be charged for less.`,
  );
  bullets.push(
    "Anything still unbilled is swept daily, so a user is not held at the limit waiting for a cycle to end.",
  );

  return { error: null, summary, bullets };
}

/** Plain-language reading of an overage ceiling, for admin settings copy. */
export function explainOverageCeiling(
  softNegativeUsdMicros: string | null | undefined,
): string {
  const raw = softNegativeUsdMicros?.trim();
  let micros = 0n;
  if (raw) {
    try {
      micros = BigInt(raw);
    } catch {
      micros = 0n;
    }
  }
  if (micros <= 0n) {
    return "No overage limit — end users keep spending past their credits as long as usage can be billed.";
  }
  return `End users can accrue up to $${formatUsdMicrosForDisplay(micros.toString())} of unbilled usage before requests are refused.`;
}

export function resolveBillingState(input: BillingStateInput): BillingState {
  const currency = input.currency;
  const spendableUsdMicros =
    input.prepaidUsdMicros + input.includedRemainingUsdMicros;

  const posture = resolvePosture({
    billingAvailable: input.billingAvailable,
    spendableUsdMicros,
    overageEligible: input.overageEligible,
    hasDefaultPaymentMethod: input.paymentMethod.hasDefault,
    softNegativeUsdMicros: input.softNegativeUsdMicros,
    unbilledDebtUsdMicros: input.unbilledDebtUsdMicros,
    leadUsdMicros: input.leadUsdMicros,
  });

  const ceiling = money(input.softNegativeUsdMicros, currency);
  const debt = input.unbilledDebtUsdMicros;
  const hasCeiling = input.softNegativeUsdMicros > 0n;

  let remaining: Money | null = null;
  let utilizationBps: number | null = null;
  if (hasCeiling && debt != null) {
    const left =
      debt >= input.softNegativeUsdMicros
        ? 0n
        : input.softNegativeUsdMicros - debt;
    remaining = money(left, currency);
    const used = debt > 0n ? debt : 0n;
    const bps = (used * 10_000n) / input.softNegativeUsdMicros;
    utilizationBps = Number(bps > 10_000n ? 10_000n : bps);
  }

  const spendable = money(spendableUsdMicros, currency);

  return {
    asOf: (input.asOf ?? new Date()).toISOString(),
    subject: input.subject,
    status: posture.status,
    canSpend: posture.canSpend,
    reason: posture.reason,
    funding: {
      prepaid: money(input.prepaidUsdMicros, currency),
      included: money(input.includedRemainingUsdMicros, currency),
      spendable,
      overage: {
        eligible: input.overageEligible,
        ceiling,
        unbilledDebt: debt != null ? money(debt, currency) : null,
        remaining,
        utilizationBps,
        debtSource: input.debtSource,
      },
    },
    collection: {
      mode: "progressive_invoice",
      collector: input.collector,
      paymentMethod: {
        hasDefault: input.paymentMethod.hasDefault,
        brand: input.paymentMethod.brand ?? null,
        last4: input.paymentMethod.last4 ?? null,
      },
      nextAction: resolveNextAction(posture),
      leadThreshold: money(input.leadUsdMicros, currency),
      minimumCharge: money(input.minimumChargeUsdMicros, currency),
      cycle: input.cycle,
      collectionInterval: input.collectionInterval,
      lastRaisedAt: input.lastRaisedAt ?? null,
      nextRaiseEligibleAt: input.nextRaiseEligibleAt ?? null,
    },
    explain: explainBillingState({
      status: posture.status,
      reason: posture.reason,
      spendable,
      ceiling,
      remaining,
    }),
  };
}
