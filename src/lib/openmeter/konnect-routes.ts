import { deepCamelToSnake, rewriteKonnectPlanRequestBody } from "./konnect-plan-body";

/**
 * Maps @openmeter/sdk paths (self-hosted /api/v1|v2) to Konnect Metering & Billing v3 paths.
 * @see https://developer.konghq.com/api/konnect/metering-and-billing/v3/
 */

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const CUSTOMER_SUBSCRIPTIONS_PATH_RE = /\/customers\/([^/]+)\/subscriptions$/;

function subjectValuesFromParams(searchParams: URLSearchParams): string[] {
  const subjects = searchParams.getAll("subject");
  if (subjects.length > 0) {
    return subjects;
  }
  const single = searchParams.get("subject")?.trim();
  return single ? [single] : [];
}

function applyKonnectPlanFields(
  item: Record<string, unknown>,
  planIdRaw: unknown,
  planKeyRaw: unknown,
): void {
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
}

export function isOpenMeterUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/** Strip SDK version prefix and apply structural path rewrites for Konnect. */
export function rewriteKonnectPathname(pathname: string, method: string): string {
  let path = pathname.replace(/\/api\/v[12](?=\/|$)/, "");

  path = path.replace(/\/billing\/profiles(?=\/|$)/, "/profiles");

  path = path.replace(/\/billing\/customers\/([^/]+)(?=\/|$)/, "/customers/$1/billing");

  const customerSubscriptions = CUSTOMER_SUBSCRIPTIONS_PATH_RE.exec(path);
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
  const customerSubscriptions = CUSTOMER_SUBSCRIPTIONS_PATH_RE.exec(normalizedPath);
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

  // OpenMeter SDK events.list uses subject/limit/from/to; Konnect expects
  // filter[subject][eq], page[size], and filter[time][gte|lte]. Without this,
  // subject is ignored and the latest global events are returned — drowning out
  // the viewer's own signed-ticket history under busy platform traffic.
  if (method.toUpperCase() === "GET" && /\/events\/?$/.test(normalizedPath)) {
    rewriteKonnectEventsListParams(params);
  }

  return params;
}

function takeTrimmedParamValues(
  params: URLSearchParams,
  key: string,
): string[] {
  const values = params
    .getAll(key)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  params.delete(key);
  return values;
}

/** Map multi-value SDK params to Konnect filter[field][eq|oeq]. */
function setKonnectEqOrOeqFilter(
  params: URLSearchParams,
  filterField: string,
  values: string[],
): void {
  if (values.length === 1) {
    params.set(`filter[${filterField}][eq]`, values[0]);
    return;
  }
  if (values.length > 1) {
    // Konnect supports comma-delimited exact match via oeq.
    params.set(`filter[${filterField}][oeq]`, values.join(","));
  }
}

function moveParamToKonnectFilter(
  params: URLSearchParams,
  sourceKey: string,
  filterKey: string,
): void {
  if (!params.has(sourceKey)) {
    return;
  }
  const value = params.get(sourceKey)?.trim();
  params.delete(sourceKey);
  if (value) {
    params.set(filterKey, value);
  }
}

function rewriteKonnectEventsListParams(params: URLSearchParams): void {
  setKonnectEqOrOeqFilter(
    params,
    "subject",
    takeTrimmedParamValues(params, "subject"),
  );
  setKonnectEqOrOeqFilter(
    params,
    "customer_id",
    takeTrimmedParamValues(params, "customerId"),
  );

  if (params.has("limit")) {
    const limit = params.get("limit");
    params.delete("limit");
    if (limit && !params.has("page[size]")) {
      params.set("page[size]", limit);
    }
  }

  moveParamToKonnectFilter(params, "from", "filter[time][gte]");
  moveParamToKonnectFilter(params, "to", "filter[time][lte]");
  moveParamToKonnectFilter(params, "ingestedAtFrom", "filter[ingested_at][gte]");
  moveParamToKonnectFilter(params, "ingestedAtTo", "filter[ingested_at][lte]");
}

export function rewriteKonnectRequestUrl(url: URL, method: string): URL {
  const next = new URL(url.toString());
  const rewrittenPath = rewriteKonnectPathname(next.pathname, method);
  next.pathname = rewrittenPath;
  next.search = rewriteKonnectSearchParams(url.pathname, method, next.searchParams).toString();
  return next;
}

/** Konnect meter queries use POST with a JSON body; the SDK issues GET + query string. */
export function isKonnectMeterQueryPath(pathname: string): boolean {
  const normalized = rewriteKonnectPathname(pathname, "GET");
  return /\/meters\/[^/]+\/query$/.test(normalized);
}

export function isKonnectMeterQueryGet(pathname: string, method: string): boolean {
  if (method.toUpperCase() !== "GET") {
    return false;
  }
  return isKonnectMeterQueryPath(pathname);
}

export function mapKonnectMeterGranularity(windowSize?: string | null): string | undefined {
  switch (windowSize?.trim().toUpperCase()) {
    case "MONTH":
      return "P1M";
    case "DAY":
      return "P1D";
    case "HOUR":
      return "PT1H";
    case "MINUTE":
      return "PT1M";
    default:
      return undefined;
  }
}

function konnectDimensionFilter(
  values: string[],
): { eq: string } | { in: string[] } | undefined {
  const trimmed = values.map((value) => value.trim()).filter(Boolean);
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length === 1) {
    return { eq: trimmed[0] };
  }
  return { in: trimmed };
}

/** Map OpenMeter SDK meter query params to Konnect MeterQueryRequest. */
export function buildKonnectMeterQueryBody(searchParams: URLSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  const groupBy = searchParams.getAll("groupBy");
  if (groupBy.length > 0) {
    body.group_by_dimensions = groupBy;
  }

  const from = searchParams.get("from")?.trim();
  const to = searchParams.get("to")?.trim();
  if (from) {
    body.from = from;
  }
  if (to) {
    body.to = to;
  }

  const granularity = mapKonnectMeterGranularity(searchParams.get("windowSize"));
  if (granularity) {
    body.granularity = granularity;
  }

  const timeZone = searchParams.get("windowTimeZone")?.trim();
  if (timeZone) {
    body.time_zone = timeZone;
  }

  const dimensionFilters: Record<string, { eq: string } | { in: string[] }> = {};
  const subjectValues = subjectValuesFromParams(searchParams);
  const subjectFilter = konnectDimensionFilter(subjectValues);
  if (subjectFilter) {
    dimensionFilters.subject = subjectFilter;
  }

  const clientId = searchParams.get("clientId")?.trim();
  if (clientId) {
    dimensionFilters.client_id = { eq: clientId };
  }

  if (Object.keys(dimensionFilters).length > 0) {
    body.filters = { dimensions: dimensionFilters };
  }

  return body;
}

/** Map Konnect meter query rows (dimensions/from/to) to OpenMeter SDK MeterQueryRow shape. */
export function normalizeKonnectMeterQueryResponse(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }

  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    return body;
  }

  const data = record.data.map((row) => {
    if (!row || typeof row !== "object") {
      return row;
    }

    const item = { ...(row as Record<string, unknown>) };
    if (item.dimensions && typeof item.dimensions === "object" && !item.groupBy) {
      item.groupBy = item.dimensions;
      delete item.dimensions;
    }
    if (item.from && !item.windowStart) {
      item.windowStart = item.from;
      delete item.from;
    }
    if (item.to && !item.windowEnd) {
      item.windowEnd = item.to;
      delete item.to;
    }
    if (typeof item.value === "string" && item.value.trim() !== "") {
      const parsed = Number(item.value);
      if (Number.isFinite(parsed)) {
        item.value = parsed;
      }
    }
    return item;
  });

  return { ...record, data };
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

function isKonnectCustomerMutation(pathname: string, method: string): boolean {
  const normalizedPath = rewriteKonnectPathname(pathname, method);
  const verb = method.toUpperCase();
  if (verb !== "POST" && verb !== "PUT" && verb !== "PATCH") {
    return false;
  }
  // /customers or /customers/{id} — not nested entitlement/credit routes.
  return /\/customers(?:\/[^/]+)?$/.test(normalizedPath);
}

function normalizeKonnectCustomerRecord(record: unknown): unknown {
  if (!record || typeof record !== "object") {
    return record;
  }
  const item = { ...(record as Record<string, unknown>) };
  const attribution =
    item.usage_attribution ?? item.usageAttribution;
  if (attribution && typeof attribution === "object") {
    const attr = attribution as Record<string, unknown>;
    const subjectKeys = attr.subject_keys ?? attr.subjectKeys;
    item.usageAttribution = {
      subjectKeys: Array.isArray(subjectKeys)
        ? subjectKeys.filter((key): key is string => typeof key === "string")
        : [],
    };
    delete item.usage_attribution;
  }
  return item;
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

  if (isKonnectCustomerMutation(pathname, method)) {
    return deepCamelToSnake(body);
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

  applyKonnectPlanFields(item, planIdRaw, planKeyRaw);

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
    Array.isArray((body as Record<string, unknown>).data) &&
    !("items" in body)
  ) {
    const data = ((body as Record<string, unknown>).data as unknown[]).map(
      (item) => normalizeKonnectCustomerRecord(normalizeKonnectSubscriptionRecord(item)),
    );
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
  if (
    listed &&
    typeof listed === "object" &&
    "id" in listed &&
    ("key" in listed || "usage_attribution" in listed || "usageAttribution" in listed)
  ) {
    return normalizeKonnectCustomerRecord(listed);
  }
  return listed;
}
