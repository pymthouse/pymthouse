import assert from "node:assert/strict";
import { test } from "node:test";

import { isKonnectMeteringUrl } from "./constants";

test("isKonnectMeteringUrl accepts konghq.com host", () => {
  assert.equal(isKonnectMeteringUrl("https://konghq.com/v3/openmeter"), true);
});

test("isKonnectMeteringUrl accepts *.konghq.com hosts", () => {
  assert.equal(
    isKonnectMeteringUrl("https://us.api.konghq.com/v3/openmeter"),
    true,
  );
});

test("isKonnectMeteringUrl rejects hosts that only contain konghq.com as a substring", () => {
  assert.equal(
    isKonnectMeteringUrl("https://evil-konghq.com.example/v3/openmeter"),
    false,
  );
});

test("isKonnectMeteringUrl falls back to kpat_/spat_ API key heuristics", () => {
  assert.equal(isKonnectMeteringUrl("not a url", "kpat_abc"), true);
  assert.equal(isKonnectMeteringUrl("http://127.0.0.1:48888", "spat_abc"), true);
  assert.equal(isKonnectMeteringUrl("http://127.0.0.1:48888", "other"), false);
  assert.equal(isKonnectMeteringUrl("http://127.0.0.1:48888"), false);
});
