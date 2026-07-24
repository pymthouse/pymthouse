import nodeTest from "node:test";
import type { TestContext } from "node:test";

/**
 * Gate DB-backed integration tests behind DATABASE_URL so local runs and CI
 * jobs without Postgres silently skip (same pattern as existing *.test.ts files).
 *
 * Exported as `test` (not an alias like `run`) so static analyzers (Sonar S2187)
 * recognize test definitions at the call site. Suite hooks (`test.after`, etc.)
 * are forwarded from `node:test` and are not DB-gated.
 */
const skipDb = !(
  process.env.DATABASE_URL && process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET !== "1"
);

type TestFn = (t: TestContext) => void | Promise<void>;

function gatedTest(name: string, fn: TestFn): void {
  nodeTest(name, { skip: skipDb }, fn);
}

export const test = Object.assign(gatedTest, {
  after: nodeTest.after.bind(nodeTest),
  afterEach: nodeTest.afterEach.bind(nodeTest),
  before: nodeTest.before.bind(nodeTest),
  beforeEach: nodeTest.beforeEach.bind(nodeTest),
  skip: nodeTest.skip.bind(nodeTest),
  todo: nodeTest.todo.bind(nodeTest),
  only: nodeTest.only.bind(nodeTest),
});

/** @deprecated Prefer `test` — kept for any remaining call sites. */
export const run = test;
