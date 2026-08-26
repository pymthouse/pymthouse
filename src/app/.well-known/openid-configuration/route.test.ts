import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "./route";
import { PROVIDER_ENDPOINT_PATHS } from "@/lib/oidc/routes";

test("discovery metadata advertises implemented endpoints", async () => {
  const response = await GET();
  assert.equal(response.status, 200);

  const payload = await response.json() as Record<string, string | string[]>;
  const issuer = payload.issuer as string;
  assert.equal(payload.authorization_endpoint, `${issuer}${PROVIDER_ENDPOINT_PATHS.authorization}`);
  assert.equal(payload.token_endpoint, `${issuer}${PROVIDER_ENDPOINT_PATHS.token}`);
  assert.equal(payload.userinfo_endpoint, `${issuer}${PROVIDER_ENDPOINT_PATHS.userinfo}`);
  assert.equal(payload.device_authorization_endpoint, `${issuer}${PROVIDER_ENDPOINT_PATHS.deviceAuthorization}`);
  assert.equal(payload.introspection_endpoint, `${issuer}${PROVIDER_ENDPOINT_PATHS.introspection}`);
  assert.equal(payload.revocation_endpoint, `${issuer}${PROVIDER_ENDPOINT_PATHS.revocation}`);
  assert.equal(payload.end_session_endpoint, `${issuer}${PROVIDER_ENDPOINT_PATHS.endSession}`);
  assert.equal(payload.registration_endpoint, `${issuer}/reg`);
  assert.ok((payload.scopes_supported as string[]).includes("sign:job"));
  assert.ok((payload.code_challenge_methods_supported as string[]).includes("S256"));
  assert.ok(!(payload.claims_supported as string[]).includes("gateway"));
});
