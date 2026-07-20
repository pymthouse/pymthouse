import assert from "node:assert/strict";
import test from "node:test";

import {
  domainDuplicateError,
  parseDomainCreateInput,
  parseDomainDeleteInput,
} from "./app-domains";

test("parseDomainCreateInput requires a domain string", () => {
  const parsed = parseDomainCreateInput({});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? "" : parsed.error, "domain is required");
});

test("parseDomainCreateInput normalizes valid domain input", () => {
  const parsed = parseDomainCreateInput({ domain: "example.com/callback" });
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.domain, "https://example.com");
});

test("parseDomainDeleteInput requires domainId", () => {
  const parsed = parseDomainDeleteInput(null);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? "" : parsed.error, "domainId query parameter is required");
});

test("domainDuplicateError formats a stable message", () => {
  assert.equal(
    domainDuplicateError("https://example.com"),
    'Domain "https://example.com" is already in the whitelist',
  );
});
