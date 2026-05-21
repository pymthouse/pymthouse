/**
 * Static plan templates for the dashboard "New plan" flow (MVP; not persisted in DB).
 */

export interface PlanTemplate {
  id: string;
  label: string;
  description: string;
  type: "free" | "subscription" | "usage";
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
    capabilityKeys: [],
    capabilityUpchargePercentBps: null,
  },
];
