import type { OwnerBillingPressure } from "@/lib/billing/owner-billing-pressure";

/**
 * Top-of-/billing intro. Must not claim Sandbox Starter when the wallet is
 * already on an Owner Paid tier (that contradiction made Producer look like a
 * Free-plan mislabel).
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
      return `${paidName} included allowance is used up and no payment method is on file. Link a card so overage can invoice, or add prepaid credits.`;
    }
    if (input.pressure === "chargeable") {
      return `Prepaid credits, active subscriptions, and platform invoices for your account. On ${paidName}, overage invoices charge your default payment method.`;
    }
    return `Prepaid credits, active subscriptions, and platform invoices for your account. You're on ${paidName} — included usage comes from your plan allowance; link a payment method for overage invoicing.`;
  }

  if (input.pressure === "blocked") {
    return `${input.starterPlanName} allowance is used up. Usage is paused until you Upgrade to a paid plan (you’ll add a payment method during Upgrade if needed).`;
  }
  if (input.pressure === "chargeable") {
    return "Prepaid credits, active subscriptions, and platform invoices for your account. Overage invoices charge your default payment method.";
  }
  return `Prepaid credits, active subscriptions, and platform invoices for your account. On ${input.starterPlanName}, usage stops when included allowance and credits run out — Upgrade to a paid plan to continue with overage invoicing.`;
}

/** Empty prepaid-credits panel when there is no card and no credit balance. */
export function billingCreditsEmptyHint(input: {
  onPaidPlan: boolean;
  currentPlanName?: string | null;
}): string {
  if (input.onPaidPlan) {
    const paidName = input.currentPlanName?.trim() || "your plan";
    return `No prepaid credit balance yet. Included usage on ${paidName} comes from your plan allowance. Link a payment method so overage can invoice after the included allowance.`;
  }
  return "No prepaid credit balance yet. Starter included usage comes from your plan allowance. Upgrade to a paid plan when you need more — overage invoices to your card after the included allowance.";
}
