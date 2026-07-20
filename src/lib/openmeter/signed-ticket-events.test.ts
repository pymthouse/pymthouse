import test from "node:test";
import assert from "node:assert/strict";

import { CREATE_SIGNED_TICKET_EVENT_TYPE } from "./constants";
import {
  aggregateManifestSessionEventStats,
  coerceIngestedEvent,
  coerceIngestedEvents,
  collectAdminSubjectsFromMeterRows,
  compareSignedTicketSessions,
  eventClientId,
  eventMatchesAdminSignedTicket,
  eventMatchesClientIdFilter,
  eventMatchesViewerSubjects,
  eventUsageSubject,
  normalizeSignedTicketEvent,
  resolveSessionBillableSecs,
  sessionEventStatsKey,
} from "./signed-ticket-events";

function sampleEvent(overrides?: {
  subject?: string;
  type?: string;
  data?: Record<string, unknown>;
  id?: string;
  time?: string;
}) {
  return {
    event: {
      id: overrides?.id ?? "evt-1",
      type: overrides?.type ?? CREATE_SIGNED_TICKET_EVENT_TYPE,
      subject: overrides?.subject ?? "app_abc:user-123",
      time: overrides?.time ?? "2026-07-11T12:00:00.000Z",
      data: {
        client_id: "app_abc",
        external_user_id: "user-123",
        usage_subject: "user-123",
        gateway_request_id: "req-1",
        pipeline: "text-to-image",
        model_id: "sdxl",
        network_fee_usd_micros: "1500",
        fee_wei: "100",
        pixels: "64",
        ...(overrides?.data ?? {}),
      },
    },
    ingestedAt: "2026-07-11T12:00:01.000Z",
  };
}

test("eventUsageSubject prefers data.external_user_id", () => {
  const ev = sampleEvent({
    subject: "app_abc:other",
    data: { external_user_id: "from-data", usage_subject: "from-usage" },
  });
  assert.equal(eventUsageSubject(ev), "from-data");
});

test("eventUsageSubject falls back to subject suffix", () => {
  const ev = sampleEvent({
    data: { external_user_id: "", usage_subject: "" },
  });
  // clear empty strings from data by rebuilding
  const bare = {
    event: {
      id: "evt-2",
      type: CREATE_SIGNED_TICKET_EVENT_TYPE,
      subject: "app_xyz:subj-9",
      time: "2026-07-11T12:00:00.000Z",
      data: {},
    },
  };
  assert.equal(eventUsageSubject(bare), "subj-9");
  assert.equal(eventClientId(bare), "app_xyz");
});

test("eventMatchesViewerSubjects keeps only viewer subjects", () => {
  const subjects = new Set(["user-123"]);
  assert.equal(eventMatchesViewerSubjects(sampleEvent(), subjects), true);
  assert.equal(
    eventMatchesViewerSubjects(
      sampleEvent({
        subject: "app_abc:other-user",
        data: { external_user_id: "other-user", usage_subject: "other-user" },
      }),
      subjects,
    ),
    false,
  );
});

test("eventMatchesViewerSubjects matches owner wallet CE subjects", () => {
  const ownerId = "2e51154b-d296-4015-990c-02d5f16ecf1e";
  const subjects = new Set([ownerId, `owner:${ownerId}`]);
  const ownerEvent = {
    event: {
      id: "evt-owner-1",
      type: CREATE_SIGNED_TICKET_EVENT_TYPE,
      subject: `owner:${ownerId}`,
      time: "2026-07-11T12:00:00.000Z",
      data: {
        client_id: "app_abc",
        external_user_id: `owner:${ownerId}`,
        usage_subject: `owner:${ownerId}`,
        gateway_request_id: "req-owner-1",
        pipeline: "text-to-image",
        model_id: "sdxl",
        network_fee_usd_micros: "1500",
      },
    },
  };
  assert.equal(eventMatchesViewerSubjects(ownerEvent, subjects), true);
  assert.equal(
    eventMatchesViewerSubjects(ownerEvent, subjects, "app_abc"),
    true,
  );
  assert.equal(
    eventMatchesViewerSubjects(ownerEvent, new Set(["someone-else"])),
    false,
  );
  assert.equal(eventClientId(ownerEvent), "app_abc");
  assert.equal(eventUsageSubject(ownerEvent), `owner:${ownerId}`);
});

test("eventClientId ignores owner: CloudEvent subject prefix", () => {
  const ownerId = "uuid-owner-1";
  const bare = {
    event: {
      id: "evt-3",
      type: CREATE_SIGNED_TICKET_EVENT_TYPE,
      subject: `owner:${ownerId}`,
      time: "2026-07-11T12:00:00.000Z",
      data: {},
    },
  };
  assert.equal(eventClientId(bare), null);
  assert.equal(eventUsageSubject(bare), `owner:${ownerId}`);
});

test("eventMatchesViewerSubjects enforces clientId filter", () => {
  const subjects = new Set(["user-123"]);
  assert.equal(
    eventMatchesViewerSubjects(sampleEvent(), subjects, "app_abc"),
    true,
  );
  assert.equal(
    eventMatchesViewerSubjects(sampleEvent(), subjects, "app_other"),
    false,
  );
});

test("eventMatchesViewerSubjects enforces clientId set filter", () => {
  const subjects = new Set(["user-123"]);
  assert.equal(
    eventMatchesViewerSubjects(sampleEvent(), subjects, new Set(["app_abc", "app_other"])),
    true,
  );
  assert.equal(
    eventMatchesViewerSubjects(sampleEvent(), subjects, new Set(["app_other"])),
    false,
  );
});

test("eventMatchesViewerSubjects rejects non signed-ticket types", () => {
  assert.equal(
    eventMatchesViewerSubjects(
      sampleEvent({ type: "other.event" }),
      new Set(["user-123"]),
    ),
    false,
  );
});

test("eventMatchesAdminSignedTicket ignores viewer subjects", () => {
  const otherUser = sampleEvent({
    subject: "app_abc:other-user",
    data: { external_user_id: "other-user", usage_subject: "other-user" },
  });
  assert.equal(eventMatchesAdminSignedTicket(otherUser), true);
  assert.equal(eventMatchesAdminSignedTicket(otherUser, "app_abc"), true);
  assert.equal(eventMatchesAdminSignedTicket(otherUser, "app_other"), false);
  assert.equal(
    eventMatchesAdminSignedTicket(otherUser, new Set(["app_abc", "app_x"])),
    true,
  );
  assert.equal(
    eventMatchesAdminSignedTicket(
      sampleEvent({ type: "other.event" }),
      "app_abc",
    ),
    false,
  );
});

test("eventMatchesClientIdFilter handles null and empty sets", () => {
  assert.equal(eventMatchesClientIdFilter(sampleEvent(), null), true);
  assert.equal(eventMatchesClientIdFilter(sampleEvent(), new Set()), true);
  assert.equal(eventMatchesClientIdFilter(sampleEvent(), ""), true);
});

test("normalizeSignedTicketEvent maps CloudEvent fields", () => {
  const row = normalizeSignedTicketEvent(
    sampleEvent({
      data: {
        manifest_id: "mid-abc",
        eth_usd_price: "3456.78",
        billable_secs: 12.5,
        fee_wei: 100,
      },
    }),
    new Map([["app_abc", "Demo App"]]),
  );
  assert.ok(row);
  assert.equal(row?.appName, "Demo App");
  assert.equal(row?.clientId, "app_abc");
  assert.equal(row?.externalUserId, "user-123");
  assert.equal(row?.gatewayRequestId, "req-1");
  assert.equal(row?.pipeline, "text-to-image");
  assert.equal(row?.modelId, "sdxl");
  assert.equal(row?.networkFeeUsdMicros, "1500");
  assert.equal(row?.feeWei, "100");
  assert.equal(row?.pixels, "64");
  assert.equal(row?.manifestId, "mid-abc");
  assert.equal(row?.ethUsdPrice, "3456.78");
  assert.equal(row?.billableSecs, 12.5);
  assert.equal(row?.time, "2026-07-11T12:00:00.000Z");
});

test("coerceIngestedEvent accepts wrapped IngestedEvent", () => {
  const coerced = coerceIngestedEvent(sampleEvent());
  assert.ok(coerced);
  assert.equal(coerced?.event.type, CREATE_SIGNED_TICKET_EVENT_TYPE);
});

test("coerceIngestedEvent accepts flat CloudEvent", () => {
  const coerced = coerceIngestedEvent({
    id: "flat-1",
    type: CREATE_SIGNED_TICKET_EVENT_TYPE,
    subject: "app_abc:user-123",
    time: "2026-07-11T12:00:00.000Z",
    data: { client_id: "app_abc", external_user_id: "user-123" },
    ingested_at: "2026-07-11T12:00:01.000Z",
  });
  assert.ok(coerced);
  assert.equal(coerced?.event.id, "flat-1");
  assert.equal(coerced?.event.subject, "app_abc:user-123");
  assert.equal(eventUsageSubject(coerced!), "user-123");
  assert.equal(
    eventMatchesViewerSubjects(coerced!, new Set(["user-123"])),
    true,
  );
});

test("coerceIngestedEvent skips undefined and empty objects", () => {
  assert.equal(coerceIngestedEvent(undefined), null);
  assert.equal(coerceIngestedEvent(null), null);
  assert.equal(coerceIngestedEvent({}), null);
  assert.equal(coerceIngestedEvent({ ingestedAt: "2026-01-01" }), null);
});

test("coerceIngestedEvents unwraps items/data envelopes and drops junk", () => {
  const rows = coerceIngestedEvents({
    items: [
      undefined,
      sampleEvent(),
      {
        id: "flat-2",
        type: CREATE_SIGNED_TICKET_EVENT_TYPE,
        subject: "app_abc:user-123",
        data: { external_user_id: "user-123" },
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.event.id, "evt-1");
  assert.equal(rows[1]?.event.id, "flat-2");
});

test("collectAdminSubjectsFromMeterRows prefers CloudEvent subject", () => {
  const subjects = collectAdminSubjectsFromMeterRows(
    [
      {
        subject: "app_story:eu-1",
        value: 10,
        groupBy: { client_id: "app_story", external_user_id: "eu-1" },
      },
      {
        subject: "owner-uuid-1",
        value: 3,
        groupBy: { client_id: "app_story", external_user_id: "owner-uuid-1" },
      },
      {
        subject: "app_other:eu-2",
        value: 99,
        groupBy: { client_id: "app_other", external_user_id: "eu-2" },
      },
    ],
    new Set(["app_story"]),
  );
  assert.ok(subjects.includes("app_story:eu-1"));
  assert.ok(subjects.includes("owner-uuid-1"));
  assert.ok(subjects.includes("eu-1"));
  assert.ok(!subjects.includes("app_other:eu-2"));
});

test("collectAdminSubjectsFromMeterRows expands external_user_id without subject", () => {
  const subjects = collectAdminSubjectsFromMeterRows(
    [
      {
        subject: null,
        value: "5",
        groupBy: {
          client_id: "app_98575870d7ae33589a3f0660",
          external_user_id: "eu-story",
        },
      },
    ],
    new Set(["app_98575870d7ae33589a3f0660"]),
  );
  assert.ok(subjects.includes("app_98575870d7ae33589a3f0660:eu-story"));
  assert.ok(subjects.includes("eu-story"));
  assert.ok(subjects.includes("owner:eu-story"));
  assert.ok(
    subjects.includes("app_98575870d7ae33589a3f0660:owner:eu-story"),
  );
});

test("aggregateManifestSessionEventStats tracks first/last and billable sum", () => {
  const stats = aggregateManifestSessionEventStats([
    sampleEvent({
      time: "2026-07-20T15:00:00.000Z",
      data: { manifest_id: "mid-1", billable_secs: 10 },
    }),
    sampleEvent({
      id: "evt-2",
      time: "2026-07-20T15:05:00.000Z",
      data: { manifest_id: "mid-1", billable_secs: "2.5" },
    }),
    sampleEvent({
      id: "evt-3",
      time: "2026-07-20T14:00:00.000Z",
      data: { manifest_id: "mid-2", billable_secs: 0 },
    }),
  ]);
  const mid1 = stats.get(sessionEventStatsKey("app_abc", "mid-1"));
  assert.ok(mid1);
  assert.equal(mid1.firstSeen, "2026-07-20T15:00:00.000Z");
  assert.equal(mid1.lastSeen, "2026-07-20T15:05:00.000Z");
  assert.equal(mid1.billableSecs, 12.5);
  const mid2 = stats.get(sessionEventStatsKey("app_abc", "mid-2"));
  assert.ok(mid2);
  assert.equal(mid2.billableSecs, 0);
});

test("aggregateManifestSessionEventStats filters to viewer subjects only", () => {
  const stats = aggregateManifestSessionEventStats(
    [
      sampleEvent({
        data: { manifest_id: "mine", billable_secs: 5 },
      }),
      sampleEvent({
        id: "evt-other",
        subject: "app_abc:other-user",
        data: {
          external_user_id: "other-user",
          usage_subject: "other-user",
          manifest_id: "theirs",
          billable_secs: 99,
        },
      }),
    ],
    { externalUserIds: new Set(["user-123", "alt-subject"]) },
  );
  assert.ok(stats.get(sessionEventStatsKey("app_abc", "mine")));
  assert.equal(stats.get(sessionEventStatsKey("app_abc", "theirs")), undefined);
});

test("aggregateManifestSessionEventStats empty subject set matches nothing", () => {
  const stats = aggregateManifestSessionEventStats(
    [sampleEvent({ data: { manifest_id: "mid-1", billable_secs: 5 } })],
    { externalUserIds: new Set() },
  );
  assert.equal(stats.size, 0);
});

test("resolveSessionBillableSecs falls back to events then wall clock", () => {
  assert.equal(resolveSessionBillableSecs("42.5", 0), "42.5");
  assert.equal(resolveSessionBillableSecs("0", 12.5), "12.5");
  assert.equal(
    resolveSessionBillableSecs(
      "0",
      0,
      "2026-07-20T15:00:00.000Z",
      "2026-07-20T15:01:30.000Z",
    ),
    "90",
  );
});

test("compareSignedTicketSessions orders open by start and ended by end", () => {
  const now = Date.parse("2026-07-20T16:00:00.000Z");
  const openRecent = {
    manifestId: "open-new",
    clientId: "app_a",
    pipeline: "p",
    modelId: "m",
    networkFeeUsdMicros: "1",
    networkFeeUsdExact: "1",
    feeWei: "1",
    billableSecs: "10",
    startedAt: "2026-07-20T15:55:00.000Z",
    endedAt: "2026-07-20T15:58:00.000Z",
  };
  const endedLater = {
    ...openRecent,
    manifestId: "ended-late",
    startedAt: "2026-07-20T14:00:00.000Z",
    endedAt: "2026-07-20T15:30:00.000Z",
  };
  const endedEarlier = {
    ...openRecent,
    manifestId: "ended-early",
    startedAt: "2026-07-20T13:00:00.000Z",
    endedAt: "2026-07-20T14:00:00.000Z",
  };
  const sorted = [endedEarlier, endedLater, openRecent].sort((a, b) =>
    compareSignedTicketSessions(a, b, now),
  );
  assert.deepEqual(
    sorted.map((s) => s.manifestId),
    ["open-new", "ended-late", "ended-early"],
  );
});
