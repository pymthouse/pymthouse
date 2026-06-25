import test from "node:test";
import assert from "node:assert/strict";
import { appendBuilderCodeSuffix, encodeErc8021Schema2Suffix } from "@/lib/x402/erc8021";

test("encodeErc8021Schema2Suffix prefixes schema byte and length", () => {
  const suffix = encodeErc8021Schema2Suffix("pymthouse");
  assert.ok(suffix.startsWith("0x02"));
  assert.ok(suffix.includes("70796d74686f757365")); // pymthouse utf8
});

test("appendBuilderCodeSuffix concatenates calldata and suffix", () => {
  const base = "0xdeadbeef" as `0x${string}`;
  const out = appendBuilderCodeSuffix(base, "app1");
  assert.ok(out.startsWith("0xdeadbeef"));
  assert.ok(out.length > base.length);
});

test("appendBuilderCodeSuffix returns calldata when builder code missing", () => {
  const base = "0xabcd" as `0x${string}`;
  assert.equal(appendBuilderCodeSuffix(base, null), base);
});
