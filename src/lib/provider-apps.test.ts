import test from "node:test";
import assert from "node:assert/strict";

import {
  canManageMerchantBilling,
  type AuthorizedProviderApp,
} from "./provider-apps";

function mockAuth(input: {
  userId: string;
  ownerId: string;
  role?: string;
}): AuthorizedProviderApp {
  return {
    userId: input.userId,
    role: input.role ?? "developer",
    app: {
      id: "app-1",
      ownerId: input.ownerId,
    } as AuthorizedProviderApp["app"],
  };
}

test("canManageMerchantBilling allows platform admin", async () => {
  const allowed = await canManageMerchantBilling(
    mockAuth({ userId: "admin-1", ownerId: "owner-1", role: "admin" }),
  );
  assert.equal(allowed, true);
});

test("canManageMerchantBilling allows app owner", async () => {
  const allowed = await canManageMerchantBilling(
    mockAuth({ userId: "owner-1", ownerId: "owner-1" }),
  );
  assert.equal(allowed, true);
});

test("canManageMerchantBilling rejects provider admin who is not owner", async () => {
  const allowed = await canManageMerchantBilling(
    mockAuth({ userId: "team-admin", ownerId: "owner-1" }),
  );
  assert.equal(allowed, false);
});
