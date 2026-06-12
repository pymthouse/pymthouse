import { rewriteKonnectPlanRequestBody } from "./konnect-plan-body";

/**
 * Maps @openmeter/sdk paths (self-hosted /api/v1|v2) to Konnect Metering & Billing v3 paths.
 * @see https://developer.konghq.com/api/konnect/metering-and-billing/v3/
 */

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

export function isOpenMeterUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/** Strip SDK version prefix and apply structural path rewrites for Konnect. */
export function rewriteKonnectPathname(pathname: string, method: string): string {
  let path = pathname.replace(/\/api\/v[12](?=\/|$)/, "");

  path = path.replace(/\/billing\/profiles(?=\/|$)/, "/profiles");

  path = path.replace(/\/billing\/customers\/([^/]+)(?=\/|$)/, "/customers/$1/billing");

  const customerSubscriptions = path.match(/\/customers\/([^/]+)\/subscriptions$/);
  if (customerSubscriptions && method.toUpperCase() === "GET") {
    return path.replace(/\/customers\/[^/]+\/subscriptions$/, "/subscriptions");
  }

  return path;
}

/** Konnect list endpoints use deepObject filters and page[size|number] pagination. */
export function rewriteKonnectSearchParams(
  pathname: string,
  method: string,
  searchParams: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(searchParams);

  const normalizedPath = pathname.replace(/\/api\/v[12](?=\/|$)/, "");
  const customerSubscriptions = normalizedPath.match(/\/customers\/([^/]+)\/subscriptions$/);
  if (customerSubscriptions && method.toUpperCase() === "GET") {
    params.set("filter[customer_id][eq]", decodeURIComponent(customerSubscriptions[1]));
  }

  if (params.has("key")) {
    const key = params.get("key") ?? "";
    params.delete("key");
    if (key.endsWith(":")) {
      params.set("filter[key][contains]", key);
    } else {
      params.set("filter[key][eq]", key);
    }
  }

  if (params.has("pageSize")) {
    const pageSize = params.get("pageSize");
    params.delete("pageSize");
    if (pageSize) {
      params.set("page[size]", pageSize);
    }
  }

  if (params.has("page")) {
    const page = params.get("page");
    params.delete("page");
    if (page) {
      params.set("page[number]", page);
    }
  }

  return params;
}

export function rewriteKonnectRequestUrl(url: URL, method: string): URL {
  const next = new URL(url.toString());
  const rewrittenPath = rewriteKonnectPathname(next.pathname, method);
  next.pathname = rewrittenPath;
  next.search = rewriteKonnectSearchParams(url.pathname, method, next.searchParams).toString();
  return next;
}

function isKonnectPlanMutation(pathname: string, method: string): boolean {
  const normalizedPath = rewriteKonnectPathname(pathname, method);
  const verb = method.toUpperCase();
  if (verb !== "POST" && verb !== "PUT" && verb !== "PATCH") {
    return false;
  }
  return /\/plans(?:\/|$)/.test(normalizedPath);
}

function rewriteKonnectSubscriptionCreateBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const record = body as Record<string, unknown>;
  if (record.customer != null) {
    return body;
  }

  const customer: Record<string, string> = {};
  if (typeof record.customerId === "string" && record.customerId.trim()) {
    customer.id = record.customerId.trim();
  }
  if (typeof record.customerKey === "string" && record.customerKey.trim()) {
    customer.key = record.customerKey.trim();
  }
  if (Object.keys(customer).length === 0) {
    return body;
  }

  const next: Record<string, unknown> = { ...record, customer };
  delete next.customerId;
  delete next.customerKey;
  return next;
}

/** Normalize SDK JSON bodies to Konnect v3 request shapes. */
export function rewriteKonnectRequestBody(
  pathname: string,
  method: string,
  body: unknown,
): unknown {
  const normalizedPath = rewriteKonnectPathname(pathname, method);
  const verb = method.toUpperCase();

  if (isKonnectPlanMutation(pathname, method)) {
    return rewriteKonnectPlanRequestBody(body);
  }

  if (verb === "POST" && normalizedPath.endsWith("/subscriptions")) {
    return rewriteKonnectSubscriptionCreateBody(body);
  }

  return body;
}

/** Konnect subscriptions expose `plan_id`; the SDK expects `plan.id` / `plan.key`. */
export function normalizeKonnectSubscriptionRecord(record: unknown): unknown {
  if (!record || typeof record !== "object") {
    return record;
  }

  const item = { ...(record as Record<string, unknown>) };
  const planIdRaw = item.plan_id ?? item.planId;
  const planKeyRaw = item.plan_key ?? item.planKey;

  if (typeof planIdRaw === "string" && planIdRaw.trim()) {
    const existingPlan =
      item.plan && typeof item.plan === "object"
        ? { ...(item.plan as Record<string, unknown>) }
        : {};
    if (!existingPlan.id && !existingPlan.key) {
      existingPlan.id = planIdRaw.trim();
    }
    item.plan = existingPlan;
  }

  if (typeof planKeyRaw === "string" && planKeyRaw.trim()) {
    const existingPlan =
      item.plan && typeof item.plan === "object"
        ? { ...(item.plan as Record<string, unknown>) }
        : {};
    if (!existingPlan.key) {
      existingPlan.key = planKeyRaw.trim();
    }
    item.plan = existingPlan;
  }

  delete item.plan_id;
  delete item.plan_key;
  return item;
}

/** Konnect page responses use `data`; the OpenMeter SDK expects `items`. */
export function normalizeKonnectListResponse(body: unknown): unknown {
  if (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    Array.isArray((body as { data: unknown }).data) &&
    !("items" in body)
  ) {
    const data = (body as { data: unknown[] }).data.map(normalizeKonnectSubscriptionRecord);
    return { ...(body as Record<string, unknown>), items: data, data };
  }
  return body;
}

/** Normalize single-entity Konnect JSON bodies for SDK parsers. */
export function normalizeKonnectResponseBody(body: unknown): unknown {
  const listed = normalizeKonnectListResponse(body);
  if (
    listed &&
    typeof listed === "object" &&
    "id" in listed &&
    "status" in listed &&
    ("plan_id" in listed || "planId" in listed || "plan" in listed)
  ) {
    return normalizeKonnectSubscriptionRecord(listed);
  }
  return listed;
}
