import assert from "node:assert/strict";
import test from "node:test";

import {
  pickOwnedAppForMcp,
  readSpecifiedAppClientId,
  type OwnedAppChoice,
} from "./owned-apps";

const alpha: OwnedAppChoice = {
  developerAppId: "app_aaa",
  publicClientId: "app_public_a",
  name: "Alpha",
};
const beta: OwnedAppChoice = {
  developerAppId: "app_bbb",
  publicClientId: "app_public_b",
  name: "Beta",
};

test("readSpecifiedAppClientId prefers app_client_id", () => {
  assert.equal(
    readSpecifiedAppClientId({ app_client_id: "app_public_b", app: "ignored" }),
    "app_public_b",
  );
  assert.equal(readSpecifiedAppClientId({ app: " app_public_a " }), "app_public_a");
  assert.equal(readSpecifiedAppClientId({}), null);
});

test("pickOwnedAppForMcp uses the specified owned app", () => {
  assert.deepEqual(pickOwnedAppForMcp([alpha, beta], "app_public_b"), beta);
});

test("pickOwnedAppForMcp rejects a specified app the user does not own", () => {
  assert.equal(pickOwnedAppForMcp([alpha], "app_public_b"), null);
});

test("pickOwnedAppForMcp defaults to the sole owned app", () => {
  assert.deepEqual(pickOwnedAppForMcp([beta]), beta);
});

test("pickOwnedAppForMcp defaults to a stable owner app when several exist", () => {
  assert.deepEqual(pickOwnedAppForMcp([beta, alpha]), alpha);
});

test("pickOwnedAppForMcp returns null when the owner has no apps", () => {
  assert.equal(pickOwnedAppForMcp([]), null);
});
