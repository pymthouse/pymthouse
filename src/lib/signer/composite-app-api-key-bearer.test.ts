import test from "node:test";
import assert from "node:assert/strict";

import { parseCompositeAppApiKeyBearer } from "@/lib/signer/composite-app-api-key-bearer";

test("parseCompositeAppApiKeyBearer accepts app_XXX.pmth_YYY format", () => {
  const parsed = parseCompositeAppApiKeyBearer(
    "app_testclient.pmth_abc123secret",
  );
  assert.deepEqual(parsed, {
    publicClientId: "app_testclient",
    pmthSecret: "pmth_abc123secret",
  });
});

test("parseCompositeAppApiKeyBearer accepts long public client ids", () => {
  const parsed = parseCompositeAppApiKeyBearer(
    "app_98575870d7ae33589a3f0660.pmth_5a68deadbeef",
  );
  assert.deepEqual(parsed, {
    publicClientId: "app_98575870d7ae33589a3f0660",
    pmthSecret: "pmth_5a68deadbeef",
  });
});

test("parseCompositeAppApiKeyBearer rejects bare pmth_ tokens", () => {
  assert.equal(parseCompositeAppApiKeyBearer("pmth_abc123"), null);
});

test("parseCompositeAppApiKeyBearer rejects JWT-shaped tokens", () => {
  assert.equal(
    parseCompositeAppApiKeyBearer("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig"),
    null,
  );
});

test("parseCompositeAppApiKeyBearer rejects missing secret suffix", () => {
  assert.equal(parseCompositeAppApiKeyBearer("app_testclient.pmth_"), null);
});
