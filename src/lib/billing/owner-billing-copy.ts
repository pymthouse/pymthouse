import type { OwnerBillingPressure } from "@/lib/billing/owner-billing-pressure";

/**
 * Top-of-/billing intro. Must not claim Sandbox Starter when the wallet is
 * already on an Owner Paid tier (that contradiction made Producer look like a
 * Free-plan mislabel). One Stripe default bills both plan fee and overage.
 */
export function billingIntroCopy(input: {
  pressure: OwnerBillingPressure;
  starterPlanName: string;
  onPaidPlan: boolean;
  currentPlanName?: string | null;
}): string {
  const paidName = input.currentPlanName?.trim() || "your paid plan";

  if (input.onPaidPlan) {
    if (input.pressure === "blocked") {
      return `${paidName} included allowance is used up and no payment method is on file. Link a card — it pays plan renewals and overage — or add prepaid credits.`;
    }
    if (input.pressure === "chargeable") {
      return `Prepaid credits, active subscriptions, and platform invoices for your account. On ${paidName}, your default payment method pays the monthly plan fee and overage.`;
    }
    return `Prepaid credits, active subscriptions, and platform invoices for your account. You're on ${paidName} — included usage comes from your plan allowance; link a payment method for renewals and overage.`;
  }

  if (input.pressure === "blocked") {
    return `${input.starterPlanName} allowance is used up. Usage is paused until you Upgrade to a paid plan (you’ll add a payment method during Upgrade if needed).`;
  }
  if (input.pressure === "chargeable") {
    return "Prepaid credits, active subscriptions, and platform invoices for your account. Your payment method is ready for a future Upgrade — it is not charged for plan fees until you Upgrade.";
  }
  return `Prepaid credits, active subscriptions, and platform invoices for your account. On ${input.starterPlanName}, usage stops when included allowance and credits run out — Upgrade to a paid plan to continue with overage invoicing.`;
}

/** Empty prepaid-credits panel when there is no card and no credit balance. */
export function billingCreditsEmptyHint(input: {
  onPaidPlan: boolean;
  currentPlanName?: string | null;
  starterPlanName?: string | null;
}): string {
  if (input.onPaidPlan) {
    const paidName = input.currentPlanName?.trim() || "your plan";
    return `No prepaid credit balance yet. Included usage on ${paidName} comes from your plan allowance. Link a payment method for renewals and overage after the included allowance.`;
  }
  const starterName = input.starterPlanName?.trim() || "Starter";
  return `No prepaid credit balance yet. ${starterName} included usage comes from your plan allowance. Upgrade to a paid plan when you need more — your payment method pays the plan fee and overage after included usage.`;
}

/** Change/Upgrade checkout: empty payment-method step. */
export function planCheckoutLinkBillingMethodCopy(mode: "upgrade" | "change"): {
  title: string;
  detail: string;
  button: string;
} {
  if (mode === "change") {
    return {
      title: "No payment method on file.",
      detail:
        "Link a payment method to confirm this plan change. It will also be used for renewals and overage.",
      button: "Link payment method via Stripe",
    };
  }
  return {
    title: "No payment method on file.",
    detail:
      "Link a payment method to confirm this upgrade. It pays the monthly plan fee and overage after included usage. Linking does not charge you until you Confirm.",
    button: "Link payment method via Stripe",
  };
}

export function planCheckoutBillingMethodOnFileHint(): string {
  return "Used for plan fee and overage.";
}
