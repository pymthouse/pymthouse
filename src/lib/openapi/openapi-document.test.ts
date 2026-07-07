import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenApiDocument } from "@/lib/openapi/document";
import "@/lib/openapi/routes";

test("buildOpenApiDocument produces OpenAPI 3.1 with credential routes", () => {
  const doc = buildOpenApiDocument();
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/api/v1/apps/{clientId}/oidc/token"]);
  assert.ok(!doc.paths["/api/v1/apps/{clientId}/auth/api-key/token"]);
  assert.ok(!doc.paths["/api/v1/apps/{clientId}/auth/api-key/signer-session"]);
  assert.ok(doc.components?.securitySchemes?.m2mBasic);
  assert.ok(doc.externalDocs?.url?.includes(".well-known/openid-configuration"));
});
