/**
 * Static plan templates for the dashboard "New plan" flow.
 * Templates seed draft fields only; they are not persisted as separate DB rows.
 */

export interface PlanTemplate {
  id: string;
  label: string;
  description: string;
  type: "free" | "subscription" | "usage";
  /** Keys: pipeline id for all models, or `pipeline|modelId` for specific models. */
  capabilityKeys: string[];
  capabilityUpchargePercentBps: number | null;
  /** Optional included USD allowance (display dollars). */
  includedUsdDisplay?: string;
  /** Optional monthly flat fee for subscription templates. */
  priceAmount?: string;
  /** Optional default usage markup percent string. */
  defaultMarkupPct?: string;
  /** Optional ISO-8601 trial phase duration. */
  trialPhaseDuration?: string;
}

export const PLAN_TEMPLATES: PlanTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Start from an empty capability list.",
    type: "free",
    capabilityKeys: [],
    capabilityUpchargePercentBps: null,
  },
  {
    id: "usage-pass-through",
    label: "Usage pass-through",
    description: "Bill end users at network cost with no markup.",
    type: "usage",
    capabilityKeys: [],
    capabilityUpchargePercentBps: 0,
    defaultMarkupPct: "0",
    includedUsdDisplay: "",
  },
  {
    id: "usage-markup-50",
    label: "Usage + 50% markup",
    description: "Usage plan with 50% retail markup over network cost.",
    type: "usage",
    capabilityKeys: [],
    capabilityUpchargePercentBps: 5000,
    defaultMarkupPct: "50",
    includedUsdDisplay: "5.00",
  },
  {
    id: "subscription-starter",
    label: "Subscription + included usage",
    description: "Monthly flat fee with included USD usage allowance.",
    type: "subscription",
    capabilityKeys: [],
    capabilityUpchargePercentBps: 0,
    priceAmount: "29.00",
    includedUsdDisplay: "10.00",
    defaultMarkupPct: "0",
    trialPhaseDuration: "P14D",
  },
];
