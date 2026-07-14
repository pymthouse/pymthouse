import { eq, inArray, sql } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";

import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients, users } from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  CREATE_SIGNED_TICKET_EVENT_TYPE,
  isOpenMeterEnabled,
  requireOpenMeterForUsageReads,
} from "@/lib/openmeter/constants";
import { getHostedOpenMeterClient } from "@/lib/openmeter/client";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerMeterSubjects,
  isOwnerCustomerKey,
  normalizePlatformUserId,
  parseOpenMeterCustomerKey,
  parseOwnerCustomerKey,
} from "@/lib/openmeter/customer-key";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const LIST_FETCH_LIMIT = 100;

export type SignedTicketRequestRow = {
  time: string;
  clientId: string;
  appName?: string;
  externalUserId: string;
  gatewayRequestId: string;
  pipeline: string;
  modelId: string;
  networkFeeUsdMicros: string;
  feeWei?: string;
  pixels?: string;
  eventId: string;
};

export type ListViewerSignedTicketRequestsInput = {
  userId: string;
  /**
   * Public OIDC client_id(s) (app_…), not developer_apps.id.
   * Prefer `clientIds`; `clientId` is kept for single-app callers.
   */
  clientId?: string | null;
  clientIds?: string[] | null;
  cursor?: string | null;
  limit?: number;
  from?: string;
  to?: string;
};

export type ListViewerSignedTicketRequestsResult = {
  items: SignedTicketRequestRow[];
  nextCursor: string | null;
  openMeterConfigured: boolean;
};

type CloudEventLike = {
  id?: string;
  type?: string;
  subject?: string;
  time?: Date | string | null;
  data?: Record<string, unknown> | null;
};

type IngestedEventLike = {
  event: CloudEventLike;
  ingestedAt?: Date | string;
};

type OffsetCursor = { offset: number };

/** Normalize SDK / Konnect list payloads into IngestedEvent-shaped rows. */
export function coerceIngestedEvent(raw: unknown): IngestedEventLike | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const row = raw as Record<string, unknown>;

  // Standard IngestedEvent: { event, ingestedAt }
  if (row.event && typeof row.event === "object") {
    const event = row.event as CloudEventLike;
    const ingestedAt =
      (row.ingestedAt as Date | string | undefined) ??
      (row.ingested_at as Date | string | undefined);
    return { event, ingestedAt };
  }

  // Flat CloudEvent (Konnect sometimes returns the event body directly).
  if (
    typeof row.type === "string" ||
    typeof row.subject === "string" ||
    typeof row.id === "string"
  ) {
    return {
      event: {
        id: typeof row.id === "string" ? row.id : undefined,
        type: typeof row.type === "string" ? row.type : undefined,
        subject: typeof row.subject === "string" ? row.subject : undefined,
        time: (row.time as Date | string | null | undefined) ?? null,
        data:
          row.data && typeof row.data === "object"
            ? (row.data as Record<string, unknown>)
            : null,
      },
      ingestedAt:
        (row.ingestedAt as Date | string | undefined) ??
        (row.ingested_at as Date | string | undefined),
    };
  }

  return null;
}

export function coerceIngestedEvents(raw: unknown): IngestedEventLike[] {
  if (!Array.isArray(raw)) {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.items)) {
        return coerceIngestedEvents(obj.items);
      }
      if (Array.isArray(obj.data)) {
        return coerceIngestedEvents(obj.data);
      }
    }
    return [];
  }
  const out: IngestedEventLike[] = [];
  for (const item of raw) {
    const coerced = coerceIngestedEvent(item);
    if (coerced) {
      out.push(coerced);
    }
  }
  return out;
}

export async function resolveViewerUsageSubjects(userId: string): Promise<Set<string>> {
  const subjects = new Set<string>();
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return subjects;
  }
  subjects.add(trimmedUserId);
  subjects.add(buildOwnerCustomerKey(trimmedUserId));
  subjects.add(`user:${trimmedUserId}`);

  const userRows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, trimmedUserId))
    .limit(1);
  const email = userRows[0]?.email?.trim().toLowerCase();
  if (!email) {
    return subjects;
  }

  const matched = await db
    .select({ externalUserId: appUsers.externalUserId })
    .from(appUsers)
    .where(sql`lower(${appUsers.email}) = ${email}`);
  for (const row of matched) {
    const ext = row.externalUserId?.trim();
    if (ext) {
      subjects.add(ext);
    }
  }

  return subjects;
}

export function eventUsageSubject(event: IngestedEventLike): string | null {
  const data = event.event?.data ?? {};
  const fromData =
    stringField(data, "external_user_id") || stringField(data, "usage_subject");
  if (fromData) {
    return fromData;
  }
  const subject = event.event?.subject?.trim() || "";
  if (isOwnerCustomerKey(subject)) {
    return subject;
  }
  const parsed = parseOpenMeterCustomerKey(subject);
  return parsed?.externalUserId ?? null;
}

export function eventClientId(event: IngestedEventLike): string | null {
  const data = event.event?.data ?? {};
  const fromData = stringField(data, "client_id");
  if (fromData && fromData !== "owner") {
    return fromData;
  }
  const subject = event.event?.subject?.trim() || "";
  // Owner wallet events use CE subject owner:{id}; client lives in data only.
  if (isOwnerCustomerKey(subject)) {
    return null;
  }
  const parsed = parseOpenMeterCustomerKey(subject);
  if (!parsed || parsed.clientId === "owner") {
    return null;
  }
  return parsed.clientId;
}

/** Expand bare / owner: / user: forms so list filters match subscription meters. */
export function expandViewerSubjectMatchKeys(
  subjects: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const raw of subjects) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    keys.add(trimmed);
    const normalized = normalizePlatformUserId(trimmed);
    keys.add(normalized);
    keys.add(buildOwnerCustomerKey(normalized));
    keys.add(`user:${normalized}`);
  }
  return keys;
}

export function eventMatchesViewerSubjects(
  event: IngestedEventLike,
  subjects: ReadonlySet<string>,
  clientIdOrIds?: string | ReadonlySet<string> | null,
): boolean {
  if (!event?.event) {
    return false;
  }
  if (event.event.type && event.event.type !== CREATE_SIGNED_TICKET_EVENT_TYPE) {
    return false;
  }
  const matchKeys = expandViewerSubjectMatchKeys(subjects);
  const usageSubject = eventUsageSubject(event);
  const ceSubject = event.event.subject?.trim() || "";
  const candidates = [usageSubject, ceSubject].filter(
    (value): value is string => Boolean(value),
  );
  const subjectMatched = candidates.some(
    (value) =>
      matchKeys.has(value) || matchKeys.has(normalizePlatformUserId(value)),
  );
  if (!subjectMatched) {
    return false;
  }
  if (clientIdOrIds == null) {
    return true;
  }
  const eventClient = eventClientId(event);
  if (!eventClient) {
    return false;
  }
  if (typeof clientIdOrIds === "string") {
    const trimmed = clientIdOrIds.trim();
    return trimmed.length === 0 || eventClient === trimmed;
  }
  if (clientIdOrIds.size === 0) {
    return true;
  }
  return clientIdOrIds.has(eventClient);
}

export function normalizeSignedTicketEvent(
  event: IngestedEventLike,
  appNameByClientId?: ReadonlyMap<string, string>,
): SignedTicketRequestRow | null {
  if (!event?.event) {
    return null;
  }
  const clientId = eventClientId(event);
  const externalUserId = eventUsageSubject(event);
  if (!clientId || !externalUserId) {
    return null;
  }
  const data = event.event.data ?? {};
  const time = toIsoTime(event.event.time) || toIsoTime(event.ingestedAt) || new Date(0).toISOString();
  const gatewayRequestId =
    stringField(data, "gateway_request_id") ||
    event.event.id?.trim() ||
    `${clientId}:${time}`;
  const networkFeeUsdMicros = microsField(data, "network_fee_usd_micros") || "0";
  return {
    time,
    clientId,
    appName: appNameByClientId?.get(clientId),
    externalUserId,
    gatewayRequestId,
    pipeline: stringField(data, "pipeline") || "unknown",
    modelId: stringField(data, "model_id") || "unknown",
    networkFeeUsdMicros,
    feeWei: stringField(data, "fee_wei") || undefined,
    pixels: stringField(data, "pixels") || undefined,
    eventId: event.event.id?.trim() || gatewayRequestId,
  };
}

export async function listViewerSignedTicketRequests(
  input: ListViewerSignedTicketRequestsInput,
): Promise<ListViewerSignedTicketRequestsResult> {
  if (!requireOpenMeterForUsageReads() || !isOpenMeterEnabled()) {
    return { items: [], nextCursor: null, openMeterConfigured: false };
  }

  const client = getHostedOpenMeterClient();
  if (!client) {
    return { items: [], nextCursor: null, openMeterConfigured: false };
  }

  const subjects = await resolveViewerUsageSubjects(input.userId);
  if (subjects.size === 0) {
    return { items: [], nextCursor: null, openMeterConfigured: true };
  }

  const cycle = calendarMonthBoundsUtc(new Date());
  const from = input.from?.trim() || cycle.start;
  const to = input.to?.trim() || cycle.end;
  const limit = clampLimit(input.limit);
  const offset = decodeOffsetCursor(input.cursor);
  const clientIdFilter = normalizeClientIdFilter(input.clientId, input.clientIds);

  const rawEvents = await fetchSignedTicketEvents({
    client,
    subjects,
    clientIds: clientIdFilter,
    from,
    to,
  });

  const matching = rawEvents.filter((ev) =>
    eventMatchesViewerSubjects(ev, subjects, clientIdFilter),
  );

  const appNames = await loadAppNames(
    matching.map((ev) => eventClientId(ev)).filter((id): id is string => Boolean(id)),
  );

  const rows = matching
    .map((ev) => normalizeSignedTicketEvent(ev, appNames))
    .filter((row): row is SignedTicketRequestRow => row != null);

  rows.sort((a, b) => {
    const byTime = b.time.localeCompare(a.time);
    if (byTime !== 0) return byTime;
    return b.eventId.localeCompare(a.eventId);
  });

  // Dedupe by event id / gateway request id (fan-out can overlap).
  const seen = new Set<string>();
  const deduped: SignedTicketRequestRow[] = [];
  for (const row of rows) {
    const key = row.eventId || row.gatewayRequestId;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const page = deduped.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor =
    nextOffset < deduped.length ? encodeOffsetCursor({ offset: nextOffset }) : null;

  return {
    items: page,
    nextCursor,
    openMeterConfigured: true,
  };
}

async function fetchSignedTicketEvents(input: {
  client: OpenMeter;
  subjects: ReadonlySet<string>;
  clientIds: ReadonlySet<string> | null;
  from: string;
  to: string;
}): Promise<IngestedEventLike[]> {
  const subjectQueries = buildSubjectQueries(input.subjects, input.clientIds);
  const batches = await Promise.all(
    subjectQueries.map(async (subject) => {
      try {
        const listed = await input.client.events.list({
          subject,
          from: input.from,
          to: input.to,
          limit: LIST_FETCH_LIMIT,
        });
        return coerceIngestedEvents(listed);
      } catch {
        // listV2 fallback when list is unavailable (some Konnect deployments).
        try {
          const listedV2 = await input.client.events.listV2({
            limit: LIST_FETCH_LIMIT,
            filter: JSON.stringify({
              type: { eq: CREATE_SIGNED_TICKET_EVENT_TYPE },
              subject: { contains: subject },
            }),
          });
          return coerceIngestedEvents(listedV2?.items ?? listedV2);
        } catch {
          return [];
        }
      }
    }),
  );
  return batches.flat();
}

function normalizeClientIdFilter(
  clientId?: string | null,
  clientIds?: string[] | null,
): ReadonlySet<string> | null {
  const ids = [
    ...(clientIds ?? []),
    ...(clientId ? [clientId] : []),
  ]
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    return null;
  }
  return new Set(ids);
}

function compoundQueriesForSubject(
  subject: string,
  clientIds: ReadonlySet<string> | null,
): string[] {
  if (clientIds && clientIds.size > 0) {
    return [...clientIds].map((clientId) =>
      buildOpenMeterCustomerKey(clientId, subject),
    );
  }
  // Partial subject match: compound auth_id ends with :external_user_id
  return [subject];
}

function addQueries(target: Set<string>, keys: Iterable<string>): void {
  for (const key of keys) {
    target.add(key);
  }
}

function addOwnerSubjectQueries(
  queries: Set<string>,
  ownerKey: string,
  clientIds: ReadonlySet<string> | null,
): void {
  const ownerUserId = parseOwnerCustomerKey(ownerKey);
  if (!ownerUserId) return;
  queries.add(ownerKey);
  queries.add(ownerUserId);
  if (clientIds && clientIds.size > 0) {
    addQueries(queries, buildOwnerMeterSubjects(ownerUserId, [...clientIds]));
    return;
  }
  addQueries(queries, compoundQueriesForSubject(ownerUserId, null));
}

function addPlatformSubjectQueries(
  queries: Set<string>,
  subject: string,
  clientIds: ReadonlySet<string> | null,
): void {
  const normalized = normalizePlatformUserId(subject);
  queries.add(subject);
  queries.add(normalized);
  queries.add(buildOwnerCustomerKey(normalized));
  if (clientIds && clientIds.size > 0) {
    addQueries(queries, buildOwnerMeterSubjects(normalized, [...clientIds]));
    for (const clientId of clientIds) {
      queries.add(buildOpenMeterCustomerKey(clientId, subject));
    }
    return;
  }
  addQueries(queries, compoundQueriesForSubject(subject, null));
}

function buildSubjectQueries(
  subjects: ReadonlySet<string>,
  clientIds: ReadonlySet<string> | null,
): string[] {
  const queries = new Set<string>();
  for (const subject of subjects) {
    const trimmed = subject.trim();
    if (!trimmed) continue;
    if (isOwnerCustomerKey(trimmed)) {
      addOwnerSubjectQueries(queries, trimmed, clientIds);
      continue;
    }
    addPlatformSubjectQueries(queries, trimmed, clientIds);
  }
  return [...queries];
}

async function loadAppNames(clientIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(clientIds.map((id) => id.trim()).filter(Boolean))];
  const map = new Map<string, string>();
  if (unique.length === 0) {
    return map;
  }

  const rows = await db
    .select({
      publicClientId: oidcClients.clientId,
      name: developerApps.name,
    })
    .from(oidcClients)
    .innerJoin(developerApps, eq(developerApps.oidcClientId, oidcClients.id))
    .where(inArray(oidcClients.clientId, unique));

  for (const row of rows) {
    const id = row.publicClientId?.trim();
    if (id) {
      map.set(id, row.name);
    }
  }
  return map;
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function microsField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

function toIsoTime(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}

function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

function encodeOffsetCursor(cursor: OffsetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeOffsetCursor(raw?: string | null): number {
  if (!raw?.trim()) {
    return 0;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(raw.trim(), "base64url").toString("utf8"),
    ) as OffsetCursor;
    if (typeof parsed.offset === "number" && Number.isFinite(parsed.offset) && parsed.offset >= 0) {
      return Math.trunc(parsed.offset);
    }
  } catch {
    // ignore malformed cursors
  }
  return 0;
}
