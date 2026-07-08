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

test("buildOpenApiDocument servers follow NEXTAUTH_URL", () => {
  const prevNextAuth = process.env.NEXTAUTH_URL;
  const prevOidcIssuer = process.env.OIDC_ISSUER;
  const prevPymthouseIssuer = process.env.PYMTHOUSE_ISSUER_URL;
  const prevPymthouseBase = process.env.PYMTHOUSE_BASE_URL;
  process.env.NEXTAUTH_URL = "https://pymthouse.com";
  delete process.env.OIDC_ISSUER;
  delete process.env.PYMTHOUSE_ISSUER_URL;
  delete process.env.PYMTHOUSE_BASE_URL;
  try {
    const doc = buildOpenApiDocument();
    assert.equal(doc.servers?.[0]?.url, "https://pymthouse.com");
    assert.equal(
      doc.externalDocs?.url,
      "https://pymthouse.com/api/v1/oidc/.well-known/openid-configuration",
    );
  } finally {
    if (prevNextAuth === undefined) {
      delete process.env.NEXTAUTH_URL;
    } else {
      process.env.NEXTAUTH_URL = prevNextAuth;
    }
    if (prevOidcIssuer === undefined) {
      delete process.env.OIDC_ISSUER;
    } else {
      process.env.OIDC_ISSUER = prevOidcIssuer;
    }
    if (prevPymthouseIssuer === undefined) {
      delete process.env.PYMTHOUSE_ISSUER_URL;
    } else {
      process.env.PYMTHOUSE_ISSUER_URL = prevPymthouseIssuer;
    }
    if (prevPymthouseBase === undefined) {
      delete process.env.PYMTHOUSE_BASE_URL;
    } else {
      process.env.PYMTHOUSE_BASE_URL = prevPymthouseBase;
    }
  }
});
