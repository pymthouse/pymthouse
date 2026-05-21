import test from "node:test";
import assert from "node:assert/strict";

import { getIssuer } from "@/lib/oidc/issuer-urls";
import { normalizeProviderPath, PROVIDER_ENDPOINT_PATHS } from "@/lib/oidc/routes";

test("OIDC issuer is mounted under /api/v1/oidc", () => {
  const issuer = getIssuer();
  assert.match(issuer, /\/api\/v1\/oidc$/);
});

test("legacy aliases map to provider endpoints", () => {
  assert.equal(
    normalizeProviderPath("/authorize"),
    PROVIDER_ENDPOINT_PATHS.authorization,
  );
  assert.equal(
    normalizeProviderPath("/userinfo"),
    PROVIDER_ENDPOINT_PATHS.userinfo,
  );
  assert.equal(
    normalizeProviderPath("/device_authorization"),
    PROVIDER_ENDPOINT_PATHS.deviceAuthorization,
  );
});
