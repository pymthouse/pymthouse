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

test("Claude DCR authorize params do not name an app", () => {
  const params = {
    response_type: "code",
    client_id: "dcr_299a362a4f80400d88b24b12ce60aeb7",
    redirect_uri: "http://localhost:58333/callback",
    scope: "openid profile email offline_access sign:job",
    prompt: "consent",
    resource: "https://staging.pymthouse.com/api/v1/mcp",
  };
  assert.equal(readSpecifiedAppClientId(params), null);
  assert.deepEqual(pickOwnedAppForMcp([alpha], null), alpha);
});

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
