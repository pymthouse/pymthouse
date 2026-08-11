import assert from "node:assert/strict";
import test from "node:test";

import {
  clientIpFromRequest,
  isCloudflareIp,
} from "@/lib/client-ip";

function withEnv(
  key: string,
  value: string | undefined,
  fn: () => void,
): void {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://example.test/", { headers });
}

test("clientIpFromRequest without VERCEL always returns unknown", () => {
  withEnv("VERCEL", undefined, () => {
    assert.equal(
      clientIpFromRequest(
        requestWith({
          "cf-connecting-ip": "203.0.113.10",
          "x-forwarded-for": "203.0.113.10, 198.51.100.1",
          "x-real-ip": "198.51.100.1",
        }),
      ),
      "unknown",
    );
  });

  withEnv("VERCEL", "0", () => {
    assert.equal(
      clientIpFromRequest(
        requestWith({
          "cf-connecting-ip": "203.0.113.10",
          "x-forwarded-for": "203.0.113.10",
        }),
      ),
      "unknown",
    );
  });
});

test("clientIpFromRequest with VERCEL=1 trusts x-real-ip over spoofed cf-connecting-ip when peer is not CF", () => {
  withEnv("VERCEL", "1", () => {
    assert.equal(
      clientIpFromRequest(
        requestWith({
          "x-real-ip": "198.51.100.50",
          "cf-connecting-ip": "203.0.113.99",
        }),
      ),
      "198.51.100.50",
    );
  });
});

test("clientIpFromRequest with VERCEL=1 trusts cf-connecting-ip when peer is Cloudflare", () => {
  withEnv("VERCEL", "1", () => {
    assert.equal(
      clientIpFromRequest(
        requestWith({
          "x-real-ip": "103.21.244.1",
          "cf-connecting-ip": "203.0.113.77",
        }),
      ),
      "203.0.113.77",
    );
  });
});

test("clientIpFromRequest with VERCEL=1 uses rightmost x-forwarded-for hop", () => {
  withEnv("VERCEL", "1", () => {
    assert.equal(
      clientIpFromRequest(
        requestWith({
          "x-forwarded-for": "203.0.113.1, 198.51.100.2, 192.0.2.9",
        }),
      ),
      "192.0.2.9",
    );
  });
});

test("isCloudflareIp matches published CF ranges and rejects private IPs", () => {
  assert.equal(isCloudflareIp("103.21.244.1"), true);
  assert.equal(isCloudflareIp("10.0.0.1"), false);
  assert.equal(isCloudflareIp("192.168.1.1"), false);
  assert.equal(isCloudflareIp("2400:cb00::1"), true);
  assert.equal(isCloudflareIp("fc00::1"), false);
});
