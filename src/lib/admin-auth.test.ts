import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import * as jose from "jose";

import { getAdminUser } from "@/lib/admin-auth";
import { createSession } from "@/lib/auth";
import { getCanonicalIssuer } from "@/lib/oidc/issuer-urls";
import { ACCESS_TOKEN_JWT_TYP, ensureSigningKey } from "@/lib/oidc/jwks";
import { test } from "@/test-utils/db-guard";
import { createTestUserWithCleanup } from "@/test-utils/fixtures";

function bearerRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/admin/billing/platform", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function signOidcAccessToken(claims: {
  sub: string;
  scope: string;
  client_id?: string;
}): Promise<string> {
  const key = await ensureSigningKey();
  const issuer = getCanonicalIssuer();
  const payload: Record<string, unknown> = {
    sub: claims.sub,
    scope: claims.scope,
  };
  if (claims.client_id !== undefined) {
    payload.client_id = claims.client_id;
  }
  return new jose.SignJWT(payload)
    .setProtectedHeader({
      alg: "RS256",
      kid: key.kid,
      typ: ACCESS_TOKEN_JWT_TYP,
    })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(crypto.randomUUID())
    .sign(key.privateKey);
}

test("getAdminUser accepts pmth bearer with admin scope and DB admin role", async (t) => {
  const adminId = await createTestUserWithCleanup(t, { role: "admin" });
  const { token } = await createSession({
    userId: adminId,
    scopes: "admin",
    expiresInDays: 1,
  });

  const admin = await getAdminUser(bearerRequest(token));
  assert.equal(admin?.id, adminId);
  assert.equal(admin?.role, "admin");
});

test("getAdminUser rejects OIDC admin JWT when the user is not a DB admin", async (t) => {
  const developerId = await createTestUserWithCleanup(t, { role: "developer" });
  const jwt = await signOidcAccessToken({
    sub: developerId,
    scope: "openid profile admin",
    client_id: "web_customer_service",
  });

  const admin = await getAdminUser(bearerRequest(jwt));
  assert.equal(admin, null);
});

test("getAdminUser accepts OIDC admin JWT for a DB admin (CS BFF)", async (t) => {
  const adminId = await createTestUserWithCleanup(t, { role: "admin" });
  const jwt = await signOidcAccessToken({
    sub: adminId,
    scope: "openid profile admin",
    client_id: "web_customer_service",
  });

  const admin = await getAdminUser(bearerRequest(jwt));
  assert.equal(admin?.id, adminId);
});

test("getAdminUser rejects OIDC admin JWT from a non-CS client", async (t) => {
  const adminId = await createTestUserWithCleanup(t, { role: "admin" });
  const jwt = await signOidcAccessToken({
    sub: adminId,
    scope: "openid profile admin",
    client_id: "web_developer_app",
  });

  const admin = await getAdminUser(bearerRequest(jwt));
  assert.equal(admin, null);
});

test("getAdminUser rejects OIDC admin JWT with no client_id", async (t) => {
  const adminId = await createTestUserWithCleanup(t, { role: "admin" });
  const jwt = await signOidcAccessToken({
    sub: adminId,
    scope: "openid profile admin",
  });

  const admin = await getAdminUser(bearerRequest(jwt));
  assert.equal(admin, null);
});

test("getAdminUser accepts OIDC admin JWT for CS_OIDC_CLIENT_ID override", async (t) => {
  const previous = process.env.CS_OIDC_CLIENT_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.CS_OIDC_CLIENT_ID;
    else process.env.CS_OIDC_CLIENT_ID = previous;
  });
  process.env.CS_OIDC_CLIENT_ID = "web_already_provisioned";

  const adminId = await createTestUserWithCleanup(t, { role: "admin" });
  const jwt = await signOidcAccessToken({
    sub: adminId,
    scope: "openid profile admin",
    client_id: "web_already_provisioned",
  });

  const admin = await getAdminUser(bearerRequest(jwt));
  assert.equal(admin?.id, adminId);
});
