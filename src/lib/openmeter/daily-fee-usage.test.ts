import assert from "node:assert/strict";
import test from "node:test";

import { querySubjectDailyFeeUsage } from "./daily-fee-usage";

test("querySubjectDailyFeeUsage aggregates meter rows by UTC day", async () => {
  let observedSubject: unknown;
  const client = {
    meters: {
      query: async (_slug: string, input: { subject: unknown }) => {
        observedSubject = input.subject;
        return {
          data: [
            { windowStart: "2026-01-01T01:00:00.000Z", value: "100" },
            { windowStart: "2026-01-01T12:00:00.000Z", value: 50 },
            { windowStart: "2026-01-02T03:00:00.000Z", value: "25" },
          ],
        };
      },
    },
  } as unknown as Parameters<typeof querySubjectDailyFeeUsage>[0]["client"];

  const result = await querySubjectDailyFeeUsage({
    client,
    subjects: ["subject_a", "subject_a", "subject_b", "  "],
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-02-01T00:00:00.000Z",
    logLabel: "test",
  });

  assert.deepEqual(observedSubject, ["subject_a", "subject_b"]);
  assert.deepEqual(result, [
    { date: "2026-01-01", usedUsdMicros: "150" },
    { date: "2026-01-02", usedUsdMicros: "25" },
  ]);
});

test("querySubjectDailyFeeUsage returns empty when no valid subjects are provided", async () => {
  let called = false;
  const client = {
    meters: {
      query: async () => {
        called = true;
        return { data: [] };
      },
    },
  } as unknown as Parameters<typeof querySubjectDailyFeeUsage>[0]["client"];

  const result = await querySubjectDailyFeeUsage({
    client,
    subjects: ["", "   "],
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-02-01T00:00:00.000Z",
    logLabel: "test",
  });

  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("querySubjectDailyFeeUsage signals onDegraded when meter query fails", async (t) => {
  t.mock.method(console, "warn", () => {});

  let degraded = false;
  const client = {
    meters: {
      query: async () => {
        throw new Error("boom");
      },
    },
  } as unknown as Parameters<typeof querySubjectDailyFeeUsage>[0]["client"];

  const result = await querySubjectDailyFeeUsage({
    client,
    subjects: ["subject_a"],
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-02-01T00:00:00.000Z",
    logLabel: "test",
    onDegraded: () => {
      degraded = true;
    },
  });

  assert.equal(degraded, true);
  assert.deepEqual(result, []);
});
