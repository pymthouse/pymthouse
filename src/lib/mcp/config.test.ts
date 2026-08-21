import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiscoveryApiUrl,
  DEFAULT_DISCOVERY_RAW_URL,
  extractBearerToken,
  readDiscoveryRawUrl,
  readDiscoveryServiceUrl,
  readLiveRunnerDiscoveryUrl,
} from "@/lib/mcp/config";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
) {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prior[key] = process.env[key];
    const next = overrides[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("extractBearerToken accepts Bearer and raw tokens", () => {
  assert.equal(extractBearerToken("Bearer abc"), "abc");
  assert.equal(extractBearerToken("raw-key"), "raw-key");
});

test("extractBearerToken rejects empty", () => {
  assert.throws(() => extractBearerToken(null), /required/);
  assert.throws(() => extractBearerToken("   "), /required/);
});

test("readDiscoveryServiceUrl prefers DISCOVERY_SERVICE_URL and strips slash", () => {
  withEnv(
    {
      DISCOVERY_SERVICE_URL: "https://discovery.example/",
      DISCOVERY_URL: "https://ignored.example",
    },
    () => {
      assert.equal(readDiscoveryServiceUrl(), "https://discovery.example");
    },
  );
});

test("readDiscoveryServiceUrl falls back to DISCOVERY_URL then default", () => {
  withEnv(
    {
      DISCOVERY_SERVICE_URL: undefined,
      DISCOVERY_URL: "https://alt.example/",
    },
    () => {
      assert.equal(readDiscoveryServiceUrl(), "https://alt.example");
    },
  );
  withEnv(
    {
      DISCOVERY_SERVICE_URL: undefined,
      DISCOVERY_URL: undefined,
    },
    () => {
      assert.match(readDiscoveryServiceUrl(), /^https:\/\//);
    },
  );
});

/** All discovery aliases, cleared so `.env` / `.env.local` cannot leak in. */
function withDiscoveryEnv(
  value: string | undefined,
  fn: () => void,
  key: "DISCOVERY_SERVICE_URL" | "DISCOVERY_URL" = "DISCOVERY_SERVICE_URL",
) {
  withEnv(
    {
      DISCOVERY_SERVICE_URL: undefined,
      DISCOVERY_URL: undefined,
      LIVEPEER_DISCOVERY_SERVICE_URL: undefined,
      [key]: value,
    },
    fn,
  );
}

test("readDiscoveryServiceUrl returns the origin of a full raw endpoint", () => {
  withDiscoveryEnv("https://discovery.example/v1/discovery/raw", () => {
    assert.equal(readDiscoveryServiceUrl(), "https://discovery.example");
    // Regression: the origin must not carry the raw path, or API joins
    // become ".../v1/discovery/raw/v1/discovery/query" (404).
    assert.equal(
      buildDiscoveryApiUrl("/v1/discovery/query"),
      "https://discovery.example/v1/discovery/query",
    );
    assert.equal(
      buildDiscoveryApiUrl("/v1/discovery/freshness"),
      "https://discovery.example/v1/discovery/freshness",
    );
  });
});

test("readDiscoveryServiceUrl keeps the port and drops path, query, fragment", () => {
  withDiscoveryEnv(
    "https://discovery.example:8443/v1/discovery/raw?serviceType=x#frag",
    () => {
      assert.equal(readDiscoveryServiceUrl(), "https://discovery.example:8443");
    },
  );
});

test("readDiscoveryRawUrl returns the configured raw endpoint", () => {
  withDiscoveryEnv("https://discovery.example/v1/discovery/raw", () => {
    assert.equal(
      readDiscoveryRawUrl(),
      "https://discovery.example/v1/discovery/raw",
    );
  });
  // Trailing slash is normalized away.
  withDiscoveryEnv("https://discovery.example/v1/discovery/raw/", () => {
    assert.equal(
      readDiscoveryRawUrl(),
      "https://discovery.example/v1/discovery/raw",
    );
  });
});

test("readDiscoveryRawUrl backfills the raw path for origin-only config", () => {
  withDiscoveryEnv("https://discovery.example", () => {
    assert.equal(
      readDiscoveryRawUrl(),
      "https://discovery.example/v1/discovery/raw",
    );
  });
  withDiscoveryEnv("https://discovery.example/", () => {
    assert.equal(
      readDiscoveryRawUrl(),
      "https://discovery.example/v1/discovery/raw",
    );
  });
});

test("readDiscoveryRawUrl honours the DISCOVERY_URL alias and defaults", () => {
  withDiscoveryEnv(
    "https://alt.example/v1/discovery/raw",
    () => {
      assert.equal(readDiscoveryRawUrl(), "https://alt.example/v1/discovery/raw");
      assert.equal(readDiscoveryServiceUrl(), "https://alt.example");
    },
    "DISCOVERY_URL",
  );
  withDiscoveryEnv(undefined, () => {
    assert.equal(readDiscoveryRawUrl(), DEFAULT_DISCOVERY_RAW_URL);
    assert.equal(
      readDiscoveryServiceUrl(),
      new URL(DEFAULT_DISCOVERY_RAW_URL).origin,
    );
  });
});

test("readLiveRunnerDiscoveryUrl scopes the raw endpoint to live-runner", () => {
  withDiscoveryEnv("https://discovery.example/v1/discovery/raw", () => {
    assert.equal(
      readLiveRunnerDiscoveryUrl(),
      "https://discovery.example/v1/discovery/raw?serviceType=live-runner",
    );
    // Regression: never ".../v1/discovery/raw/v1/discovery/raw?serviceType=...".
    assert.equal(
      readLiveRunnerDiscoveryUrl().split("/v1/discovery/raw").length,
      2,
    );
  });
  // Existing query params survive; an existing serviceType is replaced.
  withDiscoveryEnv("https://discovery.example/v1/discovery/raw?region=us", () => {
    assert.equal(
      readLiveRunnerDiscoveryUrl(),
      "https://discovery.example/v1/discovery/raw?region=us&serviceType=live-runner",
    );
  });
  withDiscoveryEnv(
    "https://discovery.example/v1/discovery/raw?serviceType=transcode",
    () => {
      assert.equal(
        readLiveRunnerDiscoveryUrl(),
        "https://discovery.example/v1/discovery/raw?serviceType=live-runner",
      );
    },
  );
});

test("discovery URL accessors reject malformed configuration", () => {
  withDiscoveryEnv("discovery.example/v1/discovery/raw", () => {
    assert.throws(
      () => readDiscoveryServiceUrl(),
      /Invalid discovery service URL/,
    );
    assert.throws(() => readDiscoveryRawUrl(), /Invalid discovery service URL/);
  });
  withDiscoveryEnv("ftp://discovery.example/raw", () => {
    assert.throws(() => readDiscoveryServiceUrl(), /must be an http\(s\) URL/);
  });
});
