import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appBillingConfig, appBillingOauthStates } from "@/db/schema";
import {
  __testSetHostedOpenMeterClient,
  resetHostedOpenMeterClientForTests,
} from "@/lib/openmeter/client";
import {
  buildStripeConnectInstallUrl,
  connectStripeOnKonnect,
  connectStripeWithApiKey,
  createStripeOAuthState,
  disconnectStripeConnect,
  formatOpenMeterBillingError,
  getStripeConnectStatus,
  parseStripeAccountIdFromConflict,
  purgeExpiredOAuthStates,
} from "./stripe-connect";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

function mockOpenMeterClient(input: {
  installWithAPIKey?: (
    type: string,
    body: { name: string; apiKey: string },
  ) => Promise<{ app: { id: string } }>;
  appsList?: () => Promise<{
    items: Array<{
      id: string;
      type: string;
      name?: string;
      stripeAccountId?: string;
    }>;
  }>;
  uninstall?: (id: string) => Promise<void>;
  createProfile?: () => Promise<{ id: string }>;
}) {
  return {
    apps: {
      marketplace: {
        installWithAPIKey:
          input.installWithAPIKey ??
          (async () => ({ app: { id: "om_stripe_installed" } })),
      },
      list: input.appsList ?? (async () => ({ items: [] })),
      uninstall: input.uninstall ?? (async () => undefined),
    },
    billing: {
      profiles: {
        create: input.createProfile ?? (async () => ({ id: "om_profile_1" })),
        list: async () => ({ items: [] }),
      },
    },
  };
}

test("parseStripeAccountIdFromConflict extracts acct id from OpenMeter 409", () => {
  const err = new Error(
    "Request failed [409]: conflict error: stripe app already exists with stripe account id: acct_1Tct0f1V1EduUmjw",
  );
  assert.equal(parseStripeAccountIdFromConflict(err), "acct_1Tct0f1V1EduUmjw");
  assert.equal(parseStripeAccountIdFromConflict(new Error("no account")), null);
});

test("buildStripeConnectInstallUrl adds state and pymthouse callback redirect_uri", () => {
  process.env.NEXTAUTH_URL = "http://localhost:3001";
  const url = buildStripeConnectInstallUrl({
    installUrl: "https://openmeter.example/api/v1/marketplace/listings/stripe/install/oauth2",
    clientId: "app_test",
    state: "csrf-state-1",
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("state"), "csrf-state-1");
  assert.equal(
    parsed.searchParams.get("redirect_uri"),
    "http://localhost:3001/api/v1/apps/app_test/billing/stripe/callback",
  );
});

test("formatOpenMeterBillingError explains unreachable OpenMeter", () => {
  const previous = process.env.OPENMETER_URL;
  process.env.OPENMETER_URL = "http://127.0.0.1:9999";
  try {
    const message = formatOpenMeterBillingError(new Error("fetch failed: ECONNREFUSED"));
    assert.match(message, /Cannot reach OpenMeter/);
    assert.match(message, /127\.0\.0\.1:9999/);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENMETER_URL;
    } else {
      process.env.OPENMETER_URL = previous;
    }
  }
});

test("formatOpenMeterBillingError explains missing Stripe OAuth on self-hosted", () => {
  const message = formatOpenMeterBillingError(new Error("Request failed [501]: unimplemented"));
  assert.match(message, /Stripe OAuth is not available/);
  assert.match(message, /sk_live_/);
});

test("formatOpenMeterBillingError passes through unknown errors", () => {
  assert.equal(formatOpenMeterBillingError(new Error("boom")), "boom");
  assert.equal(formatOpenMeterBillingError("string-err"), "string-err");
});

test("connectStripeWithApiKey rejects keys that are not sk_", async () => {
  await assert.rejects(
    () =>
      connectStripeWithApiKey({
        clientId: "app_1",
        stripeSecretKey: "rk_live_restricted",
      }),
    /must start with sk_live_ or sk_test_/,
  );
});

test("connectStripeWithApiKey installs Stripe app and writes billing config", async (t) => {
  const previousMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  t.after(() => {
    process.env.OPENMETER_ROUTE_MODE = previousMode;
    resetHostedOpenMeterClientForTests();
  });

  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));

  let installedName = "";
  __testSetHostedOpenMeterClient(
    mockOpenMeterClient({
      installWithAPIKey: async (_type, body) => {
        installedName = body.name;
        assert.equal(body.apiKey, "sk_test_abc");
        return { app: { id: "om_stripe_1" } };
      },
      createProfile: async () => ({ id: "om_profile_1" }),
    }) as never,
  );

  await connectStripeWithApiKey({
    clientId: seeded.clientId,
    stripeSecretKey: "sk_test_abc",
  });

  assert.equal(installedName, `pymthouse-${seeded.clientId}`);
  const status = await getStripeConnectStatus(seeded.clientId);
  assert.equal(status.status, "connected");
  assert.equal(status.openmeterStripeAppId, "om_stripe_1");
  assert.equal(status.openmeterBillingProfileId, "om_profile_1");
  assert.ok(status.connectedAt);
});

test("connectStripeWithApiKey reuses existing Stripe app on OpenMeter conflict", async (t) => {
  const previousMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  t.after(() => {
    process.env.OPENMETER_ROUTE_MODE = previousMode;
    resetHostedOpenMeterClientForTests();
  });

  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));

  __testSetHostedOpenMeterClient(
    mockOpenMeterClient({
      installWithAPIKey: async () => {
        throw new Error(
          "Request failed [409]: conflict error: stripe app already exists with stripe account id: acct_reuse123",
        );
      },
      appsList: async () => ({
        items: [
          {
            id: "om_existing_stripe",
            type: "stripe",
            name: `pymthouse-${seeded.clientId}`,
            stripeAccountId: "acct_reuse123",
          },
        ],
      }),
      createProfile: async () => ({ id: "om_profile_existing" }),
    }) as never,
  );

  await connectStripeWithApiKey({
    clientId: seeded.clientId,
    stripeSecretKey: "sk_live_xyz",
  });

  const status = await getStripeConnectStatus(seeded.clientId);
  assert.equal(status.openmeterStripeAppId, "om_existing_stripe");
  assert.equal(status.status, "connected");
});

test("disconnectStripeConnect clears config and uninstalls on self-hosted", async (t) => {
  const previousMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  t.after(() => {
    process.env.OPENMETER_ROUTE_MODE = previousMode;
    resetHostedOpenMeterClientForTests();
  });

  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));

  const uninstalled: string[] = [];
  __testSetHostedOpenMeterClient(
    mockOpenMeterClient({
      uninstall: async (id) => {
        uninstalled.push(id);
      },
    }) as never,
  );

  const now = new Date().toISOString();
  await db.insert(appBillingConfig).values({
    id: crypto.randomUUID(),
    clientId: seeded.clientId,
    stripeConnectStatus: "connected",
    openmeterStripeAppId: "om_to_remove",
    openmeterBillingProfileId: "profile_to_clear",
    defaultCurrency: "USD",
    connectedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await disconnectStripeConnect(seeded.clientId);
  assert.deepEqual(uninstalled, ["om_to_remove"]);

  const status = await getStripeConnectStatus(seeded.clientId);
  assert.equal(status.status, "disconnected");
  assert.equal(status.openmeterStripeAppId, null);
  assert.equal(status.openmeterBillingProfileId, null);
  assert.equal(status.connectedAt, null);
});

test("getStripeConnectStatus defaults to disconnected when no config row", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));
  const status = await getStripeConnectStatus(seeded.clientId);
  assert.equal(status.status, "disconnected");
  assert.equal(status.defaultCurrency, "USD");
});

test("getStripeConnectStatus returns OpenMeter billing profile connection status", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));

  const now = new Date().toISOString();
  await db.insert(appBillingConfig).values({
    id: crypto.randomUUID(),
    clientId: seeded.clientId,
    stripeConnectStatus: "connected",
    openmeterStripeAppId: "om_legacy",
    openmeterBillingProfileId: "om_profile_legacy",
    defaultCurrency: "USD",
    connectedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const status = await getStripeConnectStatus(seeded.clientId);
  assert.equal(status.status, "connected");
  assert.equal(status.openmeterStripeAppId, "om_legacy");
  assert.equal(status.openmeterBillingProfileId, "om_profile_legacy");
  assert.equal(status.progressiveBilling, true);
});

test("purgeExpiredOAuthStates deletes only expired rows", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));

  const now = Date.now();
  await db.insert(appBillingOauthStates).values([
    {
      id: crypto.randomUUID(),
      state: `expired-${seeded.clientId}`,
      clientId: seeded.clientId,
      userId: seeded.userId,
      expiresAt: new Date(now - 60_000).toISOString(),
      createdAt: new Date(now - 120_000).toISOString(),
    },
    {
      id: crypto.randomUUID(),
      state: `fresh-${seeded.clientId}`,
      clientId: seeded.clientId,
      userId: seeded.userId,
      expiresAt: new Date(now + 600_000).toISOString(),
      createdAt: new Date().toISOString(),
    },
  ]);

  await purgeExpiredOAuthStates();

  const remaining = await db
    .select({ state: appBillingOauthStates.state })
    .from(appBillingOauthStates)
    .where(eq(appBillingOauthStates.clientId, seeded.clientId));
  assert.deepEqual(
    remaining.map((r) => r.state).sort(),
    [`fresh-${seeded.clientId}`],
  );
});

test("createStripeOAuthState returns install URL on self-hosted OpenMeter", async (t) => {
  const previousMode = process.env.OPENMETER_ROUTE_MODE;
  const previousUrl = process.env.OPENMETER_URL;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";
  process.env.NEXTAUTH_URL = "http://localhost:3001";
  t.after(() => {
    process.env.OPENMETER_ROUTE_MODE = previousMode;
    process.env.OPENMETER_URL = previousUrl;
    resetHostedOpenMeterClientForTests();
  });

  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));

  __testSetHostedOpenMeterClient({
    apps: {
      marketplace: {
        getOauth2InstallUrl: async () => ({
          url: "https://openmeter.example/oauth2/install",
        }),
      },
    },
  } as never);

  const result = await createStripeOAuthState({
    clientId: seeded.clientId,
    userId: seeded.userId,
  });
  assert.ok(result.state);
  const parsed = new URL(result.url);
  assert.equal(parsed.origin + parsed.pathname, "https://openmeter.example/oauth2/install");
  assert.equal(parsed.searchParams.get("state"), result.state);
  assert.match(
    parsed.searchParams.get("redirect_uri") ?? "",
    new RegExp(`/api/v1/apps/${seeded.clientId}/billing/stripe/callback`),
  );
});

test("connectStripeOnKonnect finalizes via org Stripe app id", async (t) => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousMode = process.env.OPENMETER_ROUTE_MODE;
  const previousKey = process.env.OPENMETER_API_KEY;
  const previousStripeApp = process.env.OPENMETER_STRIPE_APP_ID;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  process.env.OPENMETER_API_KEY = "kpat_test";
  process.env.OPENMETER_STRIPE_APP_ID = "01KONNECTSTRIPE000000000001";
  t.after(() => {
    process.env.OPENMETER_URL = previousUrl;
    process.env.OPENMETER_ROUTE_MODE = previousMode;
    process.env.OPENMETER_API_KEY = previousKey;
    if (previousStripeApp === undefined) {
      delete process.env.OPENMETER_STRIPE_APP_ID;
    } else {
      process.env.OPENMETER_STRIPE_APP_ID = previousStripeApp;
    }
    resetHostedOpenMeterClientForTests();
  });

  const seeded = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(seeded));

  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/apps/01KONNECTSTRIPE000000000001") && method === "GET") {
      return Response.json({
        id: "01KONNECTSTRIPE000000000001",
        type: "stripe",
        status: "ready",
      });
    }
    if (url.includes("/profiles") && method === "POST") {
      return Response.json(
        { id: "01KONNECTPROFILE0000000001" },
        { status: 201 },
      );
    }
    return new Response(`unexpected ${method} ${url}`, { status: 404 });
  });

  await connectStripeOnKonnect({ clientId: seeded.clientId, name: "Acme" });
  const status = await getStripeConnectStatus(seeded.clientId);
  assert.equal(status.status, "connected");
  assert.equal(status.openmeterStripeAppId, "01KONNECTSTRIPE000000000001");
  assert.equal(status.openmeterBillingProfileId, "01KONNECTPROFILE0000000001");
});
