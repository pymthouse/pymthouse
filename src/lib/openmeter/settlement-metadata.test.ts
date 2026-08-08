import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SETTLEMENT_CHARGE_MODEL_KEY,
  SETTLEMENT_CONNECT_ACCOUNT_KEY,
  merchantSettlementMetadata,
} from "./settlement-metadata";

/**
 * Shape of `testdata/pymthouse-settlement-metadata.json`, the contract fixture
 * duplicated verbatim in pymthouse/settlement so a rename fails both repos.
 * Settlement asserts the same file in `internal/config/metadata_contract_test.go`.
 */
type SettlementMetadataFixture = {
  charge_model_key: string;
  connect_account_key: string;
  stripe_customer_key: string;
  config_env_defaults: Record<string, string>;
  e2e: { charge_model: string; connect_account_id: string };
};

const FIXTURE_RELATIVE_PATH = join(
  "testdata",
  "pymthouse-settlement-metadata.json",
);

/** Sibling settlement checkout, when the developer has both repos side by side. */
const SETTLEMENT_FIXTURE_PATH = join(
  process.cwd(),
  "..",
  "settlement",
  FIXTURE_RELATIVE_PATH,
);

function readFixture(path: string): SettlementMetadataFixture {
  assert.ok(existsSync(path), `missing settlement metadata fixture at ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as SettlementMetadataFixture;
}

test("settlement metadata keys match the shared contract fixture", () => {
  const fixture = readFixture(join(process.cwd(), FIXTURE_RELATIVE_PATH));

  assert.equal(SETTLEMENT_CHARGE_MODEL_KEY, fixture.charge_model_key);
  assert.equal(SETTLEMENT_CONNECT_ACCOUNT_KEY, fixture.connect_account_key);
  assert.equal(SETTLEMENT_CHARGE_MODEL_KEY, "stripe_charge_model");
  assert.equal(SETTLEMENT_CONNECT_ACCOUNT_KEY, "stripe_connect_account_id");

  // Settlement resolves these keys from env with the fixture values as defaults.
  assert.equal(
    fixture.config_env_defaults.SETTLEMENT_CHARGE_MODEL_METADATA_KEY,
    SETTLEMENT_CHARGE_MODEL_KEY,
  );
  assert.equal(
    fixture.config_env_defaults.SETTLEMENT_CONNECT_ACCOUNT_METADATA_KEY,
    SETTLEMENT_CONNECT_ACCOUNT_KEY,
  );

  // The e2e stamp the Konnect bootstrap writes onto customers.
  assert.deepEqual(
    merchantSettlementMetadata({
      chargeModel: "direct",
      connectedAccountId: fixture.e2e.connect_account_id,
    }),
    {
      [SETTLEMENT_CHARGE_MODEL_KEY]: fixture.e2e.charge_model,
      [SETTLEMENT_CONNECT_ACCOUNT_KEY]: fixture.e2e.connect_account_id,
    },
  );
});

test("settlement copy of the contract fixture has not drifted", (t) => {
  if (!existsSync(SETTLEMENT_FIXTURE_PATH)) {
    // CI runs one repo at a time; each side still asserts its own copy above.
    t.skip("sibling settlement checkout not present");
    return;
  }
  assert.deepEqual(
    readFixture(join(process.cwd(), FIXTURE_RELATIVE_PATH)),
    readFixture(SETTLEMENT_FIXTURE_PATH),
  );
});

test("merchantSettlementMetadata stamps charge model and account", () => {
  assert.deepEqual(
    merchantSettlementMetadata({
      connectedAccountId: " acct_123 ",
      chargeModel: "direct",
    }),
    {
      stripe_charge_model: "direct",
      stripe_connect_account_id: "acct_123",
    },
  );
});

test("merchantSettlementMetadata rejects empty account", () => {
  assert.throws(
    () =>
      merchantSettlementMetadata({
        connectedAccountId: "   ",
        chargeModel: "destination",
      }),
    /connectedAccountId is required/,
  );
});
