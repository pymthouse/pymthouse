import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInternalOpenApiDocument,
  buildOpenApiDocument,
  buildPublicOpenApiDocument,
} from "@/lib/openapi/document";
import "@/lib/openapi/routes";

test("buildPublicOpenApiDocument (v2 default) includes Builder + End-user and omits Internal", () => {
  const doc = buildPublicOpenApiDocument();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "PymtHouse Builder API");
  assert.equal(doc.info.version, "2.0.0");
  assert.ok(doc.info.description?.includes("Builder (M2M)"));
  assert.ok(doc.info.description?.includes("End-user"));
  assert.ok(Object.keys(doc.paths).every((path) => path.startsWith("/api/v2/")));

  assert.ok(doc.paths["/api/v2/apps/{clientId}"]?.get);
  assert.equal(doc.paths["/api/v2/apps/{clientId}"]?.put, undefined);
  assert.equal(doc.paths["/api/v2/apps/{clientId}"]?.delete, undefined);
  assert.equal(doc.paths["/api/v2/apps"], undefined);
  assert.equal(doc.paths["/api/v2/apps/{clientId}/admins"], undefined);
  assert.equal(doc.paths["/api/v2/end-users"], undefined);

  assert.ok(doc.paths["/api/v2/apps/{clientId}/users"]?.get);
  assert.ok(doc.paths["/api/v2/apps/{clientId}/billing/wallet"]?.get);
  assert.ok(doc.paths["/api/v2/apps/{clientId}/billing/wallet"]?.patch);
  assert.equal(
    doc.paths["/api/v2/apps/{clientId}/billing/wallet"]?.patch?.summary,
    "Set merchant auto top-up prefs",
  );
  assert.ok(doc.paths["/api/v2/apps/{clientId}/oidc/token"]?.post);
  assert.ok(doc.paths["/api/v2/builder/apps/{clientId}/usage"]?.get);
  assert.ok(doc.paths["/api/v2/apps/{clientId}/me/usage"]?.get);
  assert.ok(doc.paths["/api/v2/apps/{clientId}/me/usage/balance"]?.get);
  assert.ok(doc.paths["/api/v2/apps/{clientId}/me/usage/requests"]?.get);
  assert.ok(doc.paths["/api/v2/apps/{clientId}/me/billing/allowances"]?.get);
  assert.ok(doc.paths["/api/v2/apps/{clientId}/me/billing/wallet"]?.get);
  assert.ok(doc.tags?.some((tag) => tag.name === "End-user Billing"));
  assert.ok(doc.paths["/api/v2/user/usage"]?.get);
  assert.equal(doc.paths["/api/v2/user/usage"]?.get?.deprecated, undefined);
  assert.equal(doc.paths["/api/v2/signer"], undefined);

  // Legacy M2M operations that name the billed end user are not in v2.
  assert.equal(
    doc.paths["/api/v2/apps/{clientId}/users/{externalUserId}/payment-methods"]?.post,
    undefined,
  );
  assert.ok(doc.paths["/api/v2/apps/{clientId}/users/{externalUserId}/payment-methods"]?.get);
  assert.equal(doc.paths["/api/v2/apps/{clientId}/billing/checkout"], undefined);
  assert.equal(
    doc.paths["/api/v2/apps/{clientId}/users/{externalUserId}/allowances"]?.post,
    undefined,
  );
  // Reused v1 metadata points at v2 paths, but the OIDC issuer stays on v1.
  const meUsage = doc.paths["/api/v2/user/usage"]?.get?.description ?? "";
  assert.ok(meUsage.includes("/api/v2/apps/{clientId}/me/usage"), meUsage);
  assert.ok(!meUsage.includes("/api/v1/apps/"), meUsage);

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

test("buildPublicOpenApiDocument v1 is legacy: no /me/billing, deprecated user-billing mutations", () => {
  const doc = buildPublicOpenApiDocument({ version: "v1" });
  assert.equal(doc.info.version, "1.0.0");
  assert.ok(doc.info.title.includes("legacy"));
  assert.ok(Object.keys(doc.paths).every((path) => path.startsWith("/api/v1/")));

  assert.ok(doc.paths["/api/v1/apps/{clientId}/users"]?.get);
  assert.ok(doc.paths["/api/v1/apps/{clientId}/me/usage"]?.get);
  assert.equal(doc.paths["/api/v1/apps/{clientId}/me/billing/allowances"], undefined);
  assert.equal(doc.paths["/api/v1/apps/{clientId}/me/billing/wallet"], undefined);
  assert.ok(doc.tags?.every((tag) => tag.name !== "End-user Billing"));

  const pmPost =
    doc.paths["/api/v1/apps/{clientId}/users/{externalUserId}/payment-methods"]?.post;
  assert.equal(pmPost?.deprecated, true);
  assert.ok(pmPost?.description?.includes("/api/v2/apps/{clientId}/me/billing/payment-methods"));
  const checkout = doc.paths["/api/v1/apps/{clientId}/billing/checkout"]?.post;
  assert.equal(checkout?.deprecated, true);
  assert.equal(doc.paths["/api/v1/apps/{clientId}/users"]?.get?.deprecated, undefined);
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
  assert.equal(doc.paths["/api/v1/apps/{clientId}/me/usage"], undefined);
  assert.equal(doc.paths["/api/v1/apps/{clientId}/users"], undefined);

  assert.ok(doc.components?.securitySchemes?.adminSession);
  assert.equal(doc.components?.securitySchemes?.adminBearer, undefined);
  assert.equal(doc.components?.securitySchemes?.m2mBasic, undefined);
  const tagGroups = doc["x-tagGroups"];
  assert.ok(tagGroups?.some((group) => group.name === "Dashboard"));
});

test("buildOpenApiDocument is the current (v2) public document", () => {
  const current = buildOpenApiDocument();
  const publicDoc = buildPublicOpenApiDocument();
  assert.equal(current.info.title, publicDoc.info.title);
  assert.ok(current.paths["/api/v2/builder/apps/{clientId}/usage"]);
  assert.ok(current.paths["/api/v2/apps/{clientId}/me/usage"]);
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
