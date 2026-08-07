import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { __setGrantAllowanceUsdMicrosForTests } from "@/lib/openmeter/grant-allowance";
import { topUpGrantIdempotencyKey } from "@/lib/stripe/topup-checkout";

import { __setTopUpClientOwnedByOwnerForTests } from "./route";

const CONNECT_SECRET = "whsec_connect_test_secret";
const PLATFORM_SECRET = "whsec_platform_test_secret";

function signBody(secret: string, timestamp: number, rawBody: string): string {
  const payload = `${timestamp}.${rawBody}`;
  const v1 = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function topUpEventBody(
  type: string,
  extras?: { account?: string },
): string {
  return JSON.stringify({
    type,
    ...(extras?.account ? { account: extras.account } : {}),
    data: {
      object: {
        id: "cs_test_route_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        metadata: {
          pymthouse_topup: "1",
          owner_user_id: "user_route_1",
          client_id: "app_pub_route_1",
          amount_usd_micros: "25000000",
        },
      },
    },
  });
}

function withWebhookEnv(
  t: { after: (fn: () => void) => void },
  env: {
    connect?: string;
    platform?: string;
  },
): void {
  const prevConnect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const prevPlatform = process.env.STRIPE_WEBHOOK_SECRET;
  t.after(() => {
    if (prevConnect === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = prevConnect;
    if (prevPlatform === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevPlatform;
    __setGrantAllowanceUsdMicrosForTests(null);
    __setTopUpClientOwnedByOwnerForTests(null);
  });
  if (env.connect === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = env.connect;
  if (env.platform === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = env.platform;
}

async function postSigned(
  rawBody: string,
  secret: string,
): Promise<Response> {
  const { POST } = await import("./route");
  const now = Math.floor(Date.now() / 1000);
  return POST(
    new Request("http://localhost/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signBody(secret, now, rawBody),
      },
      body: rawBody,
    }),
  );
}

test("POST checkout.session.completed credits via grantAllowanceUsdMicros", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  const calls: Array<Record<string, unknown>> = [];
  __setGrantAllowanceUsdMicrosForTests(async (input) => {
    calls.push({ ...input, amountUsdMicros: input.amountUsdMicros.toString() });
    return {
      externalUserId: input.externalUserId,
      source: input.source,
      grantedUsdMicros: input.amountUsdMicros.toString(),
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    received?: boolean;
    credited?: boolean;
    sessionId?: string;
  };
  assert.equal(json.received, true);
  assert.equal(json.credited, true);
  assert.equal(json.sessionId, "cs_test_route_1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    clientId: "app_pub_route_1",
    externalUserId: "owner:user_route_1",
    amountUsdMicros: "25000000",
    source: "topup",
    idempotencyKey: topUpGrantIdempotencyKey("cs_test_route_1"),
  });
});

test("POST checkout.session.async_payment_succeeded credits via grantAllowanceUsdMicros", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.async_payment_succeeded");
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean };
  assert.equal(json.credited, true);
  assert.equal(granted, true);
});

test("POST ignores top-up when only Connect secret verifies", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: "not-a-whsec",
  });
  let granted = false;
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean; ignored?: string };
  assert.equal(json.credited, undefined);
  assert.equal(json.ignored, "topup_requires_platform_secret");
  assert.equal(granted, false);
});

test("POST ignores top-up with Connect account field even when platform-signed", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  let granted = false;
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed", {
    account: "acct_connected",
  });
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "connect_account_event");
  assert.equal(granted, false);
});

test("POST ignores top-up when clientId is not owned by ownerUserId", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  let granted = false;
  __setTopUpClientOwnedByOwnerForTests(async () => false);
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "client_not_owned_by_owner");
  assert.equal(granted, false);
});

test("POST rejects when signature matches neither configured secret", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setGrantAllowanceUsdMicrosForTests(async () => {
    throw new Error("grant should not run");
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, "whsec_wrong_secret");
  assert.equal(res.status, 401);
  const json = (await res.json()) as { error?: string };
  assert.equal(json.error, "invalid_signature");
});
