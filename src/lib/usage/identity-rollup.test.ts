import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppIdentityRows,
  sortIdentityRowsByFeeDesc,
  type AppIdentityRow,
} from "@/lib/usage/identity-rollup";

function meterRow(
  externalUserId: string,
  overrides: Partial<{
    requestCount: number;
    networkFeeUsdMicros: string;
    billableSecs: string;
    lastActiveDate: string | null;
  }> = {},
) {
  return {
    externalUserId,
    requestCount: overrides.requestCount ?? 1,
    networkFeeUsdMicros: overrides.networkFeeUsdMicros ?? "1000",
    billableSecs: overrides.billableSecs ?? "0",
    lastActiveDate: overrides.lastActiveDate ?? null,
  };
}

function appUser(id: string, externalUserId: string, status = "active") {
  return {
    id,
    externalUserId,
    email: null,
    status,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function apiKey(
  id: string,
  appUserId: string | null,
  overrides: Partial<{
    label: string | null;
    keyPrefix: string | null;
    status: string;
    createdAt: string;
    revokedAt: string | null;
  }> = {},
) {
  return {
    id,
    appUserId,
    label: overrides.label ?? null,
    keyPrefix: overrides.keyPrefix ?? null,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    revokedAt: overrides.revokedAt ?? null,
  };
}

test("buildAppIdentityRows sorts by network fee descending", () => {
  const rows = buildAppIdentityRows({
    meterRows: [
      meterRow("cheap", { networkFeeUsdMicros: "500" }),
      meterRow("expensive", { networkFeeUsdMicros: "900000" }),
      meterRow("middle", { networkFeeUsdMicros: "40000" }),
    ],
    appUsers: [],
    apiKeys: [],
  });

  assert.deepEqual(
    rows.map((r) => r.externalUserId),
    ["expensive", "middle", "cheap"],
  );
});

test("buildAppIdentityRows keeps metered identities that were never provisioned", () => {
  const rows = buildAppIdentityRows({
    meterRows: [meterRow("ghost", { networkFeeUsdMicros: "2500", requestCount: 7 })],
    appUsers: [],
    apiKeys: [],
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.externalUserId, "ghost");
  assert.equal(row.provisioned, false);
  assert.equal(row.status, "unprovisioned");
  assert.equal(row.appUserId, null);
  // Billable work must still be attributed, not dropped.
  assert.equal(row.requestCount, 7);
  assert.equal(row.networkFeeUsdMicros, "2500");
});

test("buildAppIdentityRows keeps provisioned identities with no usage", () => {
  const rows = buildAppIdentityRows({
    meterRows: [],
    appUsers: [appUser("au-1", "idle-user")],
    apiKeys: [],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalUserId, "idle-user");
  assert.equal(rows[0].provisioned, true);
  assert.equal(rows[0].requestCount, 0);
  assert.equal(rows[0].networkFeeUsdMicros, "0");
  assert.equal(rows[0].lastActiveDate, null);
});

test("buildAppIdentityRows joins the active API key and counts the rest", () => {
  const rows = buildAppIdentityRows({
    meterRows: [meterRow("u1")],
    appUsers: [appUser("au-1", "u1")],
    apiKeys: [
      apiKey("k-old", "au-1", {
        label: "old",
        status: "revoked",
        revokedAt: "2026-07-02T00:00:00.000Z",
        createdAt: "2026-07-05T00:00:00.000Z",
      }),
      apiKey("k-active", "au-1", { label: "prod", createdAt: "2026-07-03T00:00:00.000Z" }),
      apiKey("k-other", "au-2", { label: "someone-else" }),
    ],
  });

  assert.equal(rows.length, 1);
  // The newest key is revoked, so the active one wins despite being older.
  assert.equal(rows[0].apiKey?.id, "k-active");
  assert.equal(rows[0].apiKey?.label, "prod");
  // Keys belonging to another identity must not be counted.
  assert.equal(rows[0].apiKeyCount, 2);
});

test("buildAppIdentityRows falls back to the newest key when none are active", () => {
  const rows = buildAppIdentityRows({
    meterRows: [meterRow("u1")],
    appUsers: [appUser("au-1", "u1")],
    apiKeys: [
      apiKey("k-older", "au-1", {
        status: "revoked",
        revokedAt: "2026-07-01T00:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      apiKey("k-newer", "au-1", {
        status: "revoked",
        revokedAt: "2026-07-04T00:00:00.000Z",
        createdAt: "2026-07-04T00:00:00.000Z",
      }),
    ],
  });

  assert.equal(rows[0].apiKey?.id, "k-newer");
  assert.equal(rows[0].apiKey?.status, "revoked");
});

test("buildAppIdentityRows merges meter usage onto the provisioning row", () => {
  const rows = buildAppIdentityRows({
    meterRows: [
      meterRow("u1", {
        requestCount: 141,
        networkFeeUsdMicros: "655482",
        billableSecs: "312.5",
        lastActiveDate: "2026-07-28",
      }),
    ],
    appUsers: [appUser("au-1", "u1", "suspended")],
    apiKeys: [],
  });

  const row = rows[0];
  assert.equal(row.appUserId, "au-1");
  assert.equal(row.provisioned, true);
  assert.equal(row.status, "suspended");
  assert.equal(row.requestCount, 141);
  assert.equal(row.networkFeeUsdMicros, "655482");
  assert.equal(row.billableSecs, "312.5");
  assert.equal(row.lastActiveDate, "2026-07-28");
});

test("sortIdentityRowsByFeeDesc compares fees beyond Number precision", () => {
  const base: Omit<AppIdentityRow, "externalUserId" | "networkFeeUsdMicros"> = {
    appUserId: null,
    label: "",
    email: null,
    status: "unprovisioned",
    provisioned: false,
    apiKey: null,
    apiKeyCount: 0,
    requestCount: 0,
    billableSecs: "0",
    lastActiveDate: null,
    createdAt: null,
  };

  // Differ only past the 2^53 safe-integer boundary.
  const sorted = sortIdentityRowsByFeeDesc([
    { ...base, externalUserId: "low", networkFeeUsdMicros: "9007199254740993" },
    { ...base, externalUserId: "high", networkFeeUsdMicros: "9007199254740995" },
  ]);

  assert.deepEqual(
    sorted.map((r) => r.externalUserId),
    ["high", "low"],
  );
});

test("sortIdentityRowsByFeeDesc breaks fee ties by request count then id", () => {
  const base: Omit<AppIdentityRow, "externalUserId" | "requestCount"> = {
    appUserId: null,
    label: "",
    email: null,
    status: "unprovisioned",
    provisioned: false,
    apiKey: null,
    apiKeyCount: 0,
    networkFeeUsdMicros: "1000",
    billableSecs: "0",
    lastActiveDate: null,
    createdAt: null,
  };

  const sorted = sortIdentityRowsByFeeDesc([
    { ...base, externalUserId: "b", requestCount: 1 },
    { ...base, externalUserId: "a", requestCount: 1 },
    { ...base, externalUserId: "c", requestCount: 9 },
  ]);

  assert.deepEqual(
    sorted.map((r) => r.externalUserId),
    ["c", "a", "b"],
  );
});
