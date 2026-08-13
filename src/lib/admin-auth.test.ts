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
  const key = await ensureSigningKey();
  const issuer = getCanonicalIssuer();
  const jwt = await new jose.SignJWT({
    sub: developerId,
    scope: "openid profile admin",
    client_id: "web_customer_service",
  })
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

  const admin = await getAdminUser(bearerRequest(jwt));
  assert.equal(admin, null);
});

test("getAdminUser accepts OIDC admin JWT for a DB admin (CS BFF)", async (t) => {
  const adminId = await createTestUserWithCleanup(t, { role: "admin" });
  const key = await ensureSigningKey();
  const issuer = getCanonicalIssuer();
  const jwt = await new jose.SignJWT({
    sub: adminId,
    scope: "openid profile admin",
    client_id: "web_customer_service",
  })
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

  const admin = await getAdminUser(bearerRequest(jwt));
  assert.equal(admin?.id, adminId);
});
