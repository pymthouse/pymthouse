import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDomainWhitelist } from "./domain-whitelist";

test("normalizeDomainWhitelist accepts https host without port", () => {
  const result = normalizeDomainWhitelist("Example.COM");
  assert.deepEqual(result, {
    success: true,
    normalized: "https://example.com",
  });
});

test("normalizeDomainWhitelist keeps non-default ports for IPv4 and IPv6", () => {
  const v4 = normalizeDomainWhitelist("https://api.example.com:8443");
  assert.deepEqual(v4, {
    success: true,
    normalized: "https://api.example.com:8443",
  });

  const v6 = normalizeDomainWhitelist("https://[2001:db8::1]:8443");
  assert.deepEqual(v6, {
    success: true,
    normalized: "https://[2001:db8::1]:8443",
  });
});

test("normalizeDomainWhitelist allows http only for localhost forms", () => {
  const local = normalizeDomainWhitelist("http://localhost:3000");
  assert.deepEqual(local, {
    success: true,
    normalized: "http://localhost:3000",
  });

  const blocked = normalizeDomainWhitelist("http://example.com");
  assert.equal(blocked.success, false);
});

test("normalizeDomainWhitelist rejects empty and oversized input", () => {
  assert.equal(normalizeDomainWhitelist("   ").success, false);
  assert.equal(normalizeDomainWhitelist("x".repeat(513)).success, false);
});
