import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichSubscriptionActiveWindow,
  pickAppUserSubscriptionToReport,
} from "./subscription-read";
import type { OpenMeterSubscriptionView } from "./subscription-read";

function withKonnectEnv(t: test.TestContext): void {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  const savedMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "km_test_key";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = savedMode;
  });
}

function sub(
  partial: Partial<OpenMeterSubscriptionView> & { id: string },
): OpenMeterSubscriptionView {
  return {
    status: "active",
    customerId: "cust_1",
    planKey: "app_plan_paid",
    planId: "om_plan_paid",
    activeFrom: null,
    activeTo: null,
    ...partial,
  };
}

test("enrichSubscriptionActiveWindow fills the window Konnect v3 omits", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({
        id: "01KZCN0AH450JWA381D2AN7NJK",
        status: "canceled",
        activeFrom: "2026-08-06T23:02:17.378589Z",
        activeTo: "2026-09-06T23:02:17.378589Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const enriched = await enrichSubscriptionActiveWindow(
    sub({ id: "01KZCN0AH450JWA381D2AN7NJK", status: "canceled" }),
  );
  assert.equal(enriched.activeFrom, "2026-08-06T23:02:17.378589Z");
  assert.equal(enriched.activeTo, "2026-09-06T23:02:17.378589Z");
  assert.equal(urls.length, 1);
});

test("enrichSubscriptionActiveWindow leaves self-hosted OpenMeter rows alone", async (t) => {
  withKonnectEnv(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const canceled = sub({
    id: "sub_selfhosted_canceled",
    status: "canceled",
    activeFrom: "2026-08-06T23:02:17.378Z",
    activeTo: "2026-09-06T23:02:17.378Z",
  });
  assert.deepEqual(await enrichSubscriptionActiveWindow(canceled), canceled);

  // An open-ended live row has activeFrom but no activeTo — that is complete
  // information, not a missing window, so it must not cost a round trip.
  const live = sub({
    id: "sub_selfhosted_live",
    status: "active",
    activeFrom: "2026-08-06T23:02:17.378Z",
  });
  assert.deepEqual(await enrichSubscriptionActiveWindow(live), live);

  assert.equal(calls, 0);
});

test("enrichSubscriptionActiveWindow keeps the row when the lookup fails", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));

  const row = sub({ id: "01KZCN0AH450JWA381D2AN7NJK", status: "canceled" });
  assert.deepEqual(await enrichSubscriptionActiveWindow(row), row);
});

const isStarterByKey = (s: OpenMeterSubscriptionView) =>
  s.planKey === "app_plan_starter";

test("pickAppUserSubscriptionToReport reports a cancel-at-period-end row", () => {
  // Konnect leaves exactly this after a cancel: the occupying `canceled` row
  // plus the ended row it superseded, and no live or scheduled row anywhere.
  const canceled = sub({ id: "sub_canceled", status: "canceled" });
  const ended = sub({
    id: "sub_ended",
    status: "inactive",
    planKey: "app_plan_starter",
  });

  assert.equal(
    pickAppUserSubscriptionToReport([ended, canceled], isStarterByKey),
    canceled,
  );
});

test("pickAppUserSubscriptionToReport prefers a live row over a canceled one", () => {
  const canceled = sub({ id: "sub_canceled", status: "canceled" });
  const live = sub({ id: "sub_live", status: "active" });

  assert.equal(
    pickAppUserSubscriptionToReport([canceled, live], isStarterByKey),
    live,
  );
});

test("pickAppUserSubscriptionToReport prefers occupying canceled over scheduled successor", () => {
  const canceledStarter = sub({
    id: "sub_cape_starter",
    status: "canceled",
    planKey: "app_plan_starter",
    activeTo: "2099-01-01T00:00:00.000Z",
  });
  const scheduledPaid = sub({
    id: "sub_scheduled_ppu",
    status: "scheduled",
    planKey: "app_plan_usage",
    activeFrom: "2099-01-01T00:00:00.000Z",
  });

  assert.equal(
    pickAppUserSubscriptionToReport(
      [scheduledPaid, canceledStarter],
      isStarterByKey,
    ),
    canceledStarter,
  );
});

test("pickAppUserSubscriptionToReport reports nothing for ended rows only", () => {
  const ended = sub({ id: "sub_ended", status: "inactive" });

  assert.equal(pickAppUserSubscriptionToReport([ended], isStarterByKey), null);
  assert.equal(pickAppUserSubscriptionToReport([], isStarterByKey), null);
});
