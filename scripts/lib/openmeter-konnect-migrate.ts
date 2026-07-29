/**
 * Shared Konnect HTTP helpers for OpenMeter migration scripts.
 * Keep scripts thin so Sonar does not flag duplicated migrate boilerplate.
 */
import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  normalizeKonnectMeteringUrl,
} from "../../src/lib/openmeter/constants";
import {
  changeKonnectSubscription as changeKonnectSubscriptionLib,
  listActiveKonnectSubscriptions as listActiveKonnectSubscriptionsLib,
  type KonnectSubscription,
  type SubscriptionChangeTiming,
} from "../../src/lib/openmeter/konnect-subscriptions";

export type { KonnectSubscription, SubscriptionChangeTiming };
export { cancelKonnectSubscription } from "../../src/lib/openmeter/konnect-subscriptions";

export type KonnectPlan = {
  id: string;
  key: string;
  name?: string;
  status?: string;
  version?: number;
  settlement_mode?: string;
  currency?: string;
  billing_cadence?: string;
  phases?: Array<{
    key?: string;
    name?: string;
    rate_cards?: Array<Record<string, unknown>>;
  }>;
};

export function takeArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseSubscriptionTiming(value: string): SubscriptionChangeTiming {
  if (value !== "immediate" && value !== "next_billing_cycle") {
    throw new Error("--timing must be immediate or next_billing_cycle");
  }
  return value;
}

export function requireKonnectConfig(): { baseUrl: string; apiKey: string } {
  const rawUrl = getHostedOpenMeterUrl();
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENMETER_API_KEY is required");
  }
  if (!isKonnectMeteringUrl(rawUrl, apiKey)) {
    throw new Error(
      `This migration targets Konnect only (got OPENMETER_URL=${rawUrl})`,
    );
  }
  return {
    baseUrl: normalizeKonnectMeteringUrl(rawUrl),
    apiKey,
  };
}

export async function konnectFetch<T>(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    throw new Error(
      `Konnect ${method} ${path} failed [${response.status}]: ${String(text).slice(0, 800)}`,
    );
  }
  return parsed as T;
}

export function rateCardsHaveUsageDiscount(plan: KonnectPlan): boolean {
  return readUsageDiscountMicros(plan) != null;
}

export function readUsageDiscountMicros(plan: KonnectPlan): string | null {
  for (const phase of plan.phases ?? []) {
    for (const card of phase.rate_cards ?? []) {
      const discounts = card.discounts;
      if (!discounts || typeof discounts !== "object") continue;
      const usage = (discounts as { usage?: unknown }).usage;
      if (typeof usage === "string" || typeof usage === "number") {
        return String(usage);
      }
    }
  }
  return null;
}

export function isUsableAllowancePlan(plan: KonnectPlan): boolean {
  return (
    plan.status === "active" &&
    rateCardsHaveUsageDiscount(plan) &&
    plan.settlement_mode === KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE
  );
}

export async function getKonnectPlan(
  baseUrl: string,
  apiKey: string,
  planId: string,
): Promise<KonnectPlan> {
  return konnectFetch<KonnectPlan>(baseUrl, apiKey, "GET", `/plans/${planId}`);
}

/** Script-compatible wrapper; baseUrl/apiKey are unused (lib reads env). */
export async function listActiveKonnectSubscriptions(
  _baseUrl?: string,
  _apiKey?: string,
): Promise<KonnectSubscription[]> {
  return listActiveKonnectSubscriptionsLib();
}

/** Script-compatible wrapper; baseUrl/apiKey are unused (lib reads env). */
export async function changeKonnectSubscription(input: {
  baseUrl?: string;
  apiKey?: string;
  subscriptionId: string;
  customerId: string;
  planId: string;
  timing: SubscriptionChangeTiming;
}): Promise<{ current?: KonnectSubscription; next?: KonnectSubscription }> {
  return changeKonnectSubscriptionLib({
    subscriptionId: input.subscriptionId,
    customerId: input.customerId,
    planId: input.planId,
    timing: input.timing,
  });
}

export type KonnectCustomer = {
  id: string;
  key: string;
  name?: string;
  usage_attribution?: { subject_keys?: string[] };
};

/** PUT replace subject_keys (SDK update can leave live keys alongside deprecated). */
export async function replaceKonnectCustomerSubjectKeys(input: {
  baseUrl: string;
  apiKey: string;
  customerId: string;
  name: string;
  subjectKeys: string[];
}): Promise<KonnectCustomer> {
  return konnectFetch<KonnectCustomer>(
    input.baseUrl,
    input.apiKey,
    "PUT",
    `/customers/${input.customerId}`,
    {
      name: input.name,
      usage_attribution: { subject_keys: input.subjectKeys },
    },
  );
}

export async function getKonnectCustomer(
  baseUrl: string,
  apiKey: string,
  customerId: string,
): Promise<KonnectCustomer> {
  return konnectFetch<KonnectCustomer>(
    baseUrl,
    apiKey,
    "GET",
    `/customers/${customerId}`,
  );
}

export function readKonnectSubjectKeys(customer: KonnectCustomer): string[] {
  const keys = customer.usage_attribution?.subject_keys;
  return Array.isArray(keys)
    ? keys.filter((key): key is string => typeof key === "string")
    : [];
}
