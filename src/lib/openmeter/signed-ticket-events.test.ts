import test from "node:test";
import assert from "node:assert/strict";

import { CREATE_SIGNED_TICKET_EVENT_TYPE } from "./constants";
import {
  coerceIngestedEvent,
  coerceIngestedEvents,
  eventClientId,
  eventMatchesViewerSubjects,
  eventUsageSubject,
  normalizeSignedTicketEvent,
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

test("normalizeSignedTicketEvent maps CloudEvent fields", () => {
  const row = normalizeSignedTicketEvent(
    sampleEvent(),
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
