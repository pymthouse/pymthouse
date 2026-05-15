/**
 * Static plan templates for the dashboard "New plan" flow (MVP; not persisted in DB).
 */

export interface PlanTemplate {
  id: string;
  label: string;
  description: string;
  type: "free" | "subscription" | "usage";
  generalUpchargePercentBps: number | null;
  payPerUseUpchargePercentBps: number | null;
  /** Keys: pipeline id for all models, or `pipeline|modelId` for specific models. */
  capabilityKeys: string[];
  capabilityUpchargePercentBps: number | null;
}

export const PLAN_TEMPLATES: PlanTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Start from an empty capability list.",
    type: "free",
    generalUpchargePercentBps: null,
    payPerUseUpchargePercentBps: null,
    capabilityKeys: [],
    capabilityUpchargePercentBps: null,
  },
  {
    id: "retail-upcharge",
    label: "Retail +20%",
    description: "General 20% upcharge on network-priced models (no per-model rows).",
    type: "free",
    generalUpchargePercentBps: 2000,
    payPerUseUpchargePercentBps: null,
    capabilityKeys: [],
    capabilityUpchargePercentBps: null,
  },
];
