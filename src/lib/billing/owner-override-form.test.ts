import assert from "node:assert/strict";
import test from "node:test";

import { buildOwnerOverridePatchBody } from "@/lib/billing/owner-override-form";

test("buildOwnerOverridePatchBody converts USD form fields to micros", () => {
  const built = buildOwnerOverridePatchBody({
    starterDisplay: "25.00",
    endUserCap: "40",
    note: "partner",
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.body.starterIncludedUsdMicros, "25000000");
  assert.equal(built.body.endUserCap, 40);
  assert.equal(built.body.applicationFeeBps, undefined);
  assert.equal(built.body.note, "partner");
});

test("buildOwnerOverridePatchBody clears empty fields to null", () => {
  const built = buildOwnerOverridePatchBody({
    starterDisplay: "",
    endUserCap: "",
    note: "  ",
    clearStarter: true,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.body.starterIncludedUsdMicros, null);
  assert.equal(built.body.endUserCap, null);
  assert.equal(built.body.applicationFeeBps, undefined);
  assert.equal(built.body.note, null);
});

test("buildOwnerOverridePatchBody rejects invalid numeric fields", () => {
  assert.equal(
    buildOwnerOverridePatchBody({
      starterDisplay: "nope",
      endUserCap: "",
      note: "",
    }).ok,
    false,
  );
  assert.equal(
    buildOwnerOverridePatchBody({
      starterDisplay: "",
      endUserCap: "0",
      note: "",
    }).ok,
    false,
  );
});
