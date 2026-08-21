import assert from "node:assert/strict";

import { test } from "node:test";

import { loadExistingGrant } from "./load-existing-grant";

function grantCtx(overrides: {
  consentGrantId?: string;
  sessionGrantId?: string;
  clientId?: string;
  accountId?: string;
  found?: { accountId: string; clientId: string } | null;
}) {
  const clientId = overrides.clientId ?? "web_customer_service";
  return {
    oidc: {
      result: overrides.consentGrantId
        ? { consent: { grantId: overrides.consentGrantId } }
        : undefined,
      client: { clientId },
      account: overrides.accountId ? { accountId: overrides.accountId } : undefined,
      session: {
        grantIdFor: (id: string) =>
          id === clientId ? overrides.sessionGrantId : undefined,
      },
      provider: {
        Grant: {
          find: async (id: string) => {
            if (overrides.found === null) return undefined;
            if (overrides.found) return overrides.found;
            return {
              accountId: overrides.accountId ?? "acct",
              clientId,
              jti: id,
            };
          },
        },
      },
    },
  } as never;
}

test("loadExistingGrant prefers consent grantId and does not require session", async () => {
  const grant = await loadExistingGrant(
    grantCtx({
      consentGrantId: "g1",
      accountId: "acct",
    }),
  );
  assert.equal((grant as { jti?: string })?.jti, "g1");
});

test("loadExistingGrant returns undefined when session is missing", async () => {
  const ctx = grantCtx({ accountId: "acct" }) as {
    oidc: { session?: unknown };
  };
  ctx.oidc.session = undefined;
  const grant = await loadExistingGrant(ctx as never);
  assert.equal(grant, undefined);
});

test("loadExistingGrant ignores grants for a different account instead of throwing", async () => {
  const grant = await loadExistingGrant(
    grantCtx({
      sessionGrantId: "stale",
      accountId: "admin",
      found: { accountId: "other", clientId: "web_customer_service" },
    }),
  );
  assert.equal(grant, undefined);
});
