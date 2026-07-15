import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInternalOpenApiDocument,
  buildOpenApiDocument,
  buildPublicOpenApiDocument,
} from "@/lib/openapi/document";
import "@/lib/openapi/routes";

test("buildPublicOpenApiDocument includes Builder + End-user and omits Internal", () => {
  const doc = buildPublicOpenApiDocument();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "PymtHouse API");
  assert.ok(doc.info.description?.includes("Builder (M2M)"));
  assert.ok(doc.info.description?.includes("End-user"));

  assert.ok(doc.paths["/api/v1/apps/{clientId}"]?.get);
  assert.equal(doc.paths["/api/v1/apps/{clientId}"]?.put, undefined);
  assert.equal(doc.paths["/api/v1/apps/{clientId}"]?.delete, undefined);
  assert.equal(doc.paths["/api/v1/apps"], undefined);
  assert.equal(doc.paths["/api/v1/apps/{clientId}/admins"], undefined);
  assert.equal(doc.paths["/api/v1/internal/apps"], undefined);

  assert.ok(doc.paths["/api/v1/apps/{clientId}/users"]?.get);
  assert.ok(doc.paths["/api/v1/apps/{clientId}/oidc/token"]?.post);
  assert.ok(doc.paths["/api/v1/builder/apps/{clientId}/usage"]?.get);
  assert.ok(doc.paths["/api/v1/user/usage"]?.get);
  assert.ok(doc.paths["/api/v1/user/usage/balance"]?.get);
  assert.ok(doc.paths["/api/v1/user/usage/requests"]?.get);
  assert.equal(doc.paths["/api/v1/signer"], undefined);

  assert.ok(doc.components?.securitySchemes?.m2mBasic);
  assert.ok(doc.components?.securitySchemes?.endUserBearer);
  assert.equal(doc.components?.securitySchemes?.adminSession, undefined);
  assert.ok(doc.tags?.every((tag) => tag.name !== "Apps"));
  assert.ok(doc.tags?.some((tag) => tag.name === "Users"));
  assert.ok(doc.tags?.some((tag) => tag.name === "End-user Usage"));
  const tagGroups = doc["x-tagGroups"];
  assert.ok(tagGroups?.some((group) => group.name === "Integrator"));
  assert.ok(tagGroups?.some((group) => group.name === "End-user"));
  assert.ok(!tagGroups?.some((group) => group.name === "Dashboard"));
});

test("buildInternalOpenApiDocument documents /internal paths and session auth", () => {
  const doc = buildInternalOpenApiDocument();
  assert.equal(doc.info.title, "PymtHouse Internal API");
  assert.ok(doc.info.description?.includes("dashboard"));

  assert.ok(doc.paths["/api/v1/internal/apps"]?.get);
  assert.ok(doc.paths["/api/v1/internal/apps/{clientId}/admins"]?.get);
  assert.ok(doc.paths["/api/v1/internal/me/usage/requests"]?.get);
  assert.ok(doc.paths["/api/v1/internal/signer"]?.get);

  assert.equal(doc.paths["/api/v1/builder/apps/{clientId}/usage"], undefined);
  assert.equal(doc.paths["/api/v1/user/usage"], undefined);
  assert.equal(doc.paths["/api/v1/apps/{clientId}/users"], undefined);

  assert.ok(doc.components?.securitySchemes?.adminSession);
  assert.equal(doc.components?.securitySchemes?.adminBearer, undefined);
  assert.equal(doc.components?.securitySchemes?.m2mBasic, undefined);
  const tagGroups = doc["x-tagGroups"];
  assert.ok(tagGroups?.some((group) => group.name === "Dashboard"));
});

test("buildOpenApiDocument aliases public", () => {
  const legacy = buildOpenApiDocument();
  const publicDoc = buildPublicOpenApiDocument();
  assert.equal(legacy.info.title, publicDoc.info.title);
  assert.ok(legacy.paths["/api/v1/builder/apps/{clientId}/usage"]);
  assert.ok(legacy.paths["/api/v1/user/usage"]);
});

test("buildPublicOpenApiDocument servers follow NEXTAUTH_URL", () => {
  const prevNextAuth = process.env.NEXTAUTH_URL;
  const prevPymthouseIssuer = process.env.PYMTHOUSE_ISSUER_URL;
  const prevPymthouseBase = process.env.PYMTHOUSE_BASE_URL;
  const prevOidcIssuer = process.env.OIDC_ISSUER;
  process.env.NEXTAUTH_URL = "https://pymthouse.com";
  process.env.PYMTHOUSE_ISSUER_URL = "http://localhost:3001/api/v1/oidc";
  process.env.PYMTHOUSE_BASE_URL = "http://localhost:3001";
  process.env.OIDC_ISSUER = "http://localhost:3001/api/v1/oidc";
  try {
    const doc = buildPublicOpenApiDocument();
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
    if (prevOidcIssuer === undefined) {
      delete process.env.OIDC_ISSUER;
    } else {
      process.env.OIDC_ISSUER = prevOidcIssuer;
    }
  }
});
