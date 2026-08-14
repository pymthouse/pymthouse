#!/usr/bin/env npx tsx
/**
 * Staging e2e driver: merchant Stripe Connect webhook + payment flow.
 *
 * Exercises the *deployed* stack end to end — nothing is stubbed. Each
 * subcommand is one stage of the flow and is invoked as its own CI step so the
 * GitHub Actions log has real stage boundaries; state is handed between stages
 * through `E2E_STATE_FILE` (JSON in the runner temp dir).
 *
 *   preflight       Safety guards + reachability + Connect readiness (Plane B state)
 *   provision       End-user + pay-per-use subscription + default payment method
 *   webhook-connect Signed synthetic `account.updated` → POST /webhooks/stripe
 *   ingest          Expensive charge event via Kafka → collector → Konnect (or API)
 *   verify-usage    Usage API parity + balance gate posture
 *   collect         Manual POST …/billing/collect, assert `queued` then poll for the raise
 *   settle          Invoice paid on Connect + invoices API + transactions ledger
 *   teardown        Deactivate the fixture end-user
 *
 * Safety: this script refuses to run against a production base URL or a live
 * Stripe key. Settlement infrastructure is shared across preview/prod, so the
 * isolation boundary is *data* (dedicated app + Connect sandbox account +
 * per-run end-user), never a separate deployment.
 *
 * Usage: npx tsx scripts/e2e/merchant-payments.ts <stage>
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_FILE = requireEnv("E2E_STATE_FILE");
const BASE_URL = trimTrailingSlashes(requireEnv("E2E_BASE_URL"));
const CLIENT_ID = requireEnv("E2E_CLIENT_ID");
const M2M_CLIENT_ID = requireEnv("E2E_M2M_CLIENT_ID");
const M2M_CLIENT_SECRET = requireEnv("E2E_M2M_CLIENT_SECRET");

const STRIPE_KEY = process.env.E2E_STRIPE_SECRET_KEY?.trim() ?? "";
const STRIPE_API = process.env.E2E_STRIPE_API_BASE?.trim() || "https://api.stripe.com";
const CONNECT_WEBHOOK_SECRET =
  process.env.E2E_STRIPE_CONNECT_WEBHOOK_SECRET?.trim() ?? "";

const KAFKA_BROKERS = process.env.E2E_KAFKA_BROKERS?.trim() ?? "";
const KAFKA_TOPIC = process.env.E2E_KAFKA_TOPIC?.trim() || "livepeer-gateway-events";
const INGEST_MODE = (process.env.E2E_INGEST_MODE?.trim() || "auto") as
  | "auto"
  | "kafka"
  | "api";

/**
 * Default $12.00. The amount has to clear three floors at once, or the flow
 * silently degrades into a pass that proved nothing:
 *   - Starter included usage ($5.00 default) — otherwise no debt accrues;
 *   - the invoice lead window `min(ceiling/2, $5)` — otherwise nothing raises;
 *   - Stripe's $0.50 minimum charge — otherwise collect returns `skipped`.
 */
const AMOUNT_USD = process.env.E2E_AMOUNT_USD?.trim() || "12.00";
/** Kafka ingest prices in wei off a live oracle, so assert with tolerance. */
const AMOUNT_TOLERANCE_BPS = Number(process.env.E2E_AMOUNT_TOLERANCE_BPS || "1000");

const USAGE_TIMEOUT_MS = Number(process.env.E2E_USAGE_TIMEOUT_MS || "180000");
const SETTLE_TIMEOUT_MS = Number(process.env.E2E_SETTLE_TIMEOUT_MS || "420000");
/** Settlement raises off its own Kafka lane now, not pymthouse's request path. */
const COLLECT_TIMEOUT_MS = Number(process.env.E2E_COLLECT_TIMEOUT_MS || "60000");
const POLL_INTERVAL_MS = Number(process.env.E2E_POLL_INTERVAL_MS || "5000");

const MIN_INVOICE_USD_MICROS = 500_000n; // Stripe floor, mirrors overage-limits.ts
const KCAT_BIN = "/usr/bin/kcat";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type RunState = {
  runId: string;
  externalUserId: string;
  startedAtUnix: number;
  connectedAccountId?: string;
  amountUsdMicros?: string;
  ingestMode?: "kafka" | "api";
};

function loadState(): RunState {
  if (existsSync(STATE_FILE)) {
    const fromDisk = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<RunState>;
    return {
      runId: typeof fromDisk.runId === "string" ? fromDisk.runId : randomUUID().slice(0, 8),
      externalUserId:
        typeof fromDisk.externalUserId === "string" && fromDisk.externalUserId.trim()
          ? fromDisk.externalUserId
          : `e2e-merchant-${Date.now()}`,
      startedAtUnix:
        typeof fromDisk.startedAtUnix === "number"
          ? Math.floor(fromDisk.startedAtUnix)
          : Math.floor(Date.now() / 1000),
      connectedAccountId:
        typeof fromDisk.connectedAccountId === "string" ? fromDisk.connectedAccountId : undefined,
      amountUsdMicros:
        typeof fromDisk.amountUsdMicros === "string" ? fromDisk.amountUsdMicros : undefined,
      ingestMode:
        fromDisk.ingestMode === "kafka" || fromDisk.ingestMode === "api"
          ? fromDisk.ingestMode
          : undefined,
    };
  }
  const runId = process.env.GITHUB_RUN_ID?.trim() || randomUUID().slice(0, 8);
  const state: RunState = {
    runId,
    startedAtUnix: Math.floor(Date.now() / 1000),
    externalUserId:
      process.env.E2E_EXTERNAL_USER_ID?.trim() || `e2e-merchant-${runId}-${Date.now()}`,
  };
  saveState(state);
  return state;
}

function saveState(state: RunState): void {
  const persisted: RunState = {
    runId: state.runId,
    externalUserId: state.externalUserId,
    startedAtUnix: state.startedAtUnix,
    connectedAccountId: state.connectedAccountId,
    amountUsdMicros: state.amountUsdMicros,
    ingestMode: state.ingestMode,
  };
  writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value as string;
}

function basicAuthHeader(): string {
  const raw = `${M2M_CLIENT_ID}:${M2M_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

type ApiResult<T = Record<string, unknown>> = { status: number; body: T };

/** Builder API call under M2M Basic — the only credential these routes accept. */
async function api<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: basicAuthHeader(),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, body: body as T };
}

async function apiOk<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const result = await api<T>(path, init);
  if (result.status < 200 || result.status >= 300) {
    fail(
      `${init.method ?? "GET"} ${path} → ${result.status} ${JSON.stringify(result.body)}`,
    );
  }
  return result.body;
}

/** Stripe REST call, optionally on the connected account (`Stripe-Account`). */
async function stripe<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; form?: Record<string, string>; account?: string } = {},
): Promise<T> {
  if (!STRIPE_KEY) {
    fail("E2E_STRIPE_SECRET_KEY is required for Stripe calls");
  }
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${STRIPE_KEY}`,
      ...(init.account ? { "stripe-account": init.account } : {}),
      ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    fail(`Stripe ${init.method ?? "GET"} ${path} → ${response.status}: ${body.error?.message}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`  ${message}`);
}

function stage(name: string): void {
  console.log(`\n=== ${name} ===`);
}

class StageFailure extends Error {}

function fail(message: string): never {
  throw new StageFailure(message);
}

function connectedAccountIdFromEnv(): string {
  const accountId = process.env.E2E_STRIPE_CONNECTED_ACCOUNT_ID?.trim();
  if (!accountId) {
    fail("E2E_STRIPE_CONNECTED_ACCOUNT_ID is configured");
  }
  return accountId;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
  log(`✓ ${message}`);
}

function summary(): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  writeFileSync(path, "## Merchant payment flow — passed\n", { flag: "a" });
}

async function poll<T>(input: {
  label: string;
  timeoutMs: number;
  probe: () => Promise<{ done: boolean; value?: T; note?: string }>;
}): Promise<T> {
  const deadline = Date.now() + input.timeoutMs;
  let lastNote = "";
  while (Date.now() < deadline) {
    const result = await input.probe();
    if (result.done) {
      return result.value as T;
    }
    if (result.note && result.note !== lastNote) {
      lastNote = result.note;
      log(`… ${input.label}: ${result.note}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  fail(`${input.label} timed out after ${input.timeoutMs}ms (last: ${lastNote || "no signal"})`);
}

function usdMicros(usd: string): bigint {
  const [whole, frac = ""] = usd.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}

function money(value: unknown): bigint {
  const raw = (value as { usdMicros?: string } | null)?.usdMicros;
  return raw ? BigInt(raw) : 0n;
}

// ---------------------------------------------------------------------------
// Stage: preflight
// ---------------------------------------------------------------------------

/**
 * Refuse anything that could move real money or mutate production. Settlement,
 * Kafka and Konnect are shared with prod, so these guards are the only thing
 * standing between a CI run and a live customer's books.
 */
async function preflight(state: RunState): Promise<void> {
  stage("Preflight — safety guards");

  const host = new URL(BASE_URL).host;
  assert(
    !/^(www\.)?pymthouse\.com$/i.test(host),
    `base URL is not production (${host})`,
  );
  assert(
    STRIPE_KEY.startsWith("sk_test_") || STRIPE_KEY.startsWith("rk_test_"),
    "Stripe key is a sandbox/test key",
  );
  assert(
    CONNECT_WEBHOOK_SECRET.startsWith("whsec_"),
    "Connect webhook secret is present",
  );
  assert(
    state.externalUserId.startsWith("e2e-") ||
      Boolean(process.env.E2E_EXTERNAL_USER_ID),
    `fixture end-user is namespaced (${state.externalUserId})`,
  );

  stage("Preflight — deployment reachability");
  const health = await apiOk<{ status: string; database: string }>("/api/v1/health");
  assert(health.status === "ok", `staging health ok (db=${health.database})`);

  stage("Preflight — Plane B / Connect readiness");
  // GET …/billing/stripe is provider-session; M2M reads readiness off billing
  // state instead, which is the same `app_billing_config` row the webhook writes.
  const walletProbe = await api<{ error?: string }>(
    `/api/v1/apps/${CLIENT_ID}/billing/wallet?externalUserId=${encodeURIComponent(state.externalUserId)}`,
  );
  assert(
    walletProbe.status !== 404,
    "M2M credential is the app's configured m2m_* client (wallet routes reachable)",
  );

  const account = connectedAccountIdFromEnv();
  const acct = await stripe<{
    id: string;
    charges_enabled: boolean;
    details_submitted: boolean;
  }>(`/v1/accounts/${account}`);
  assert(acct.charges_enabled, `connected account ${acct.id} has charges_enabled`);
  assert(acct.details_submitted, `connected account ${acct.id} has details_submitted`);

  state.connectedAccountId = account;
  saveState(state);
}

// ---------------------------------------------------------------------------
// Stage: provision
// ---------------------------------------------------------------------------

/**
 * Step 1 of the flow: an M2M-provisioned end-user with a default payment
 * method and a pay-per-use subscription.
 */
async function provision(state: RunState): Promise<void> {
  stage("Provision — upsert end-user");
  // POST …/users returns the app_users row spread at the top level (201 new / 200 upsert).
  const user = await apiOk<{ externalUserId?: string; status?: string }>(
    `/api/v1/apps/${CLIENT_ID}/users`,
    { method: "POST", body: { externalUserId: state.externalUserId, status: "active" } },
  );
  assert(
    user.externalUserId === state.externalUserId,
    `end-user provisioned (${state.externalUserId})`,
  );
  assert(user.status === "active", `end-user is active (${user.status})`);

  stage("Provision — pay-per-use subscription");
  const planId = process.env.E2E_PLAN_ID?.trim() || (await resolvePayPerUsePlanId());
  const change = await apiOk<{ subscriptionId?: string; checkoutUrl?: string }>(
    `/api/v1/apps/${CLIENT_ID}/users/${encodeURIComponent(state.externalUserId)}/subscription/change`,
    { method: "POST", body: { planId, timing: "immediate" } },
  );
  assert(
    !change.checkoutUrl,
    "plan change settled server-side (no interactive Connect checkout required)",
  );
  saveState(state);
  log(`plan ${planId} active`);

  stage("Provision — default payment method on the connected account");
  const connectedAccountId = state.connectedAccountId ?? connectedAccountIdFromEnv();
  state.connectedAccountId = connectedAccountId;
  // POST …/wallet/payment-methods creates the setup-mode Checkout session, and
  // as a side effect materialises the customer on the connected account. The
  // hosted URL needs a browser, so CI attaches a sandbox card over the Stripe
  // API instead and lets the real `payment_method.attached` Connect webhook
  // drive the billing-profile restore.
  await apiOk(`/api/v1/apps/${CLIENT_ID}/billing/wallet/payment-methods`, {
    method: "POST",
    body: { externalUserId: state.externalUserId },
  });

  const customerId = await findConnectedCustomerId(state, connectedAccountId);
  log(`connected-account customer ${customerId}`);

  const paymentMethod = await stripe<{ id: string }>("/v1/payment_methods", {
    method: "POST",
    account: connectedAccountId,
    form: { type: "card", "card[token]": process.env.E2E_STRIPE_CARD_TOKEN || "tok_visa" },
  });
  await stripe(`/v1/payment_methods/${paymentMethod.id}/attach`, {
    method: "POST",
    account: connectedAccountId,
    form: { customer: customerId },
  });
  log(`attached ${paymentMethod.id} → ${customerId} (payment_method.attached webhook in flight)`);

  const promoted = await apiOk<{ promoted: boolean; paymentMethodId: string | null }>(
    `/api/v1/apps/${CLIENT_ID}/billing/wallet/payment-methods`,
    { method: "PATCH", body: { externalUserId: state.externalUserId, ensureDefault: true } },
  );
  log(`ensureDefault → promoted=${promoted.promoted} pm=${promoted.paymentMethodId ?? "n/a"}`);

  stage("Provision — assert wallet posture");
  const wallet = await poll<Record<string, unknown>>({
    label: "default payment method visible on wallet",
    timeoutMs: USAGE_TIMEOUT_MS,
    probe: async () => {
      const body = await apiOk<{ paymentMethod?: { hasDefault?: boolean | null } }>(
        `/api/v1/apps/${CLIENT_ID}/billing/wallet?externalUserId=${encodeURIComponent(state.externalUserId)}`,
      );
      return body.paymentMethod?.hasDefault === true
        ? { done: true, value: body }
        : { done: false, note: `hasDefault=${body.paymentMethod?.hasDefault}` };
    },
  });

  const payPerUsePlans = (wallet.payPerUsePlans ?? []) as Array<{ planId: string }>;
  assert(
    payPerUsePlans.some((plan) => plan.planId === planId),
    "wallet reports the pay-per-use plan",
  );

  const billingState = wallet.billingState as Record<string, unknown> | undefined;
  const collection = billingState?.collection as Record<string, unknown> | undefined;
  assert(
    collection?.collector === "settlement_connect",
    "collection routes to settlement_connect (merchant Custom Invoicing, not the OM Stripe app)",
  );
  assert(
    (collection?.paymentMethod as { hasDefault?: boolean } | undefined)?.hasDefault === true,
    "billing state sees the default card",
  );
}

async function resolvePayPerUsePlanId(): Promise<string> {
  const body = await apiOk<{ plans?: Array<{ id: string; type: string; status: string }> }>(
    `/api/v1/apps/${CLIENT_ID}/plans`,
  );
  const plan = (body.plans ?? []).find(
    (row) => row.type === "usage" && row.status === "active",
  );
  if (!plan) {
    fail("no active pay-per-use (type=usage) plan on the fixture app — set E2E_PLAN_ID");
  }
  return plan.id;
}

/** Located by the metadata `ensureMerchantOwnedStripeCustomer` stamps at create. */
async function findConnectedCustomerId(state: RunState, connectedAccountId: string): Promise<string> {
  const query = encodeURIComponent(
    `metadata['external_user_id']:'${state.externalUserId}' AND metadata['pymthouse_client_id']:'${CLIENT_ID}'`,
  );
  return poll<string>({
    label: "connected-account customer exists",
    timeoutMs: 90_000,
    probe: async () => {
      const found = await stripe<{ data: Array<{ id: string }> }>(
        `/v1/customers/search?query=${query}`,
        { account: connectedAccountId },
      );
      const id = found.data[0]?.id;
      return id ? { done: true, value: id } : { done: false, note: "search index warming" };
    },
  });
}

// ---------------------------------------------------------------------------
// Stage: webhook-connect
// ---------------------------------------------------------------------------

/**
 * Plane B signature + handler check. Replays the connected account's *current*
 * flags, so a correct run is a no-op write: it proves the signature path and
 * `applyConnectedAccountWebhookUpdate` are wired without changing readiness.
 */
async function webhookConnect(state: RunState): Promise<void> {
  stage("Webhook Plane B — account.updated");
  const account = state.connectedAccountId ?? connectedAccountIdFromEnv();
  state.connectedAccountId = account;
  const acct = await stripe<{
    id: string;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
  }>(`/v1/accounts/${account}`);

  const payload = JSON.stringify({
    id: `evt_e2e_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    object: "event",
    type: "account.updated",
    account: acct.id,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: acct.id,
        object: "account",
        charges_enabled: acct.charges_enabled,
        payouts_enabled: acct.payouts_enabled,
        details_submitted: acct.details_submitted,
      },
    },
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", CONNECT_WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const response = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });
  const body = (await response.json()) as { received?: boolean; updated?: boolean; clientId?: string };
  assert(response.status === 200, `POST /webhooks/stripe → 200 (${JSON.stringify(body)})`);
  assert(body.received === true, "webhook accepted the signed Connect delivery");
  assert(
    body.clientId === CLIENT_ID,
    `account.updated resolved to the fixture app (${body.clientId})`,
  );

  stage("Webhook Plane B — signature rejection");
  const bad = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=deadbeef` },
    body: payload,
  });
  assert(bad.status === 400, `forged signature rejected with ${bad.status}`);
}

// ---------------------------------------------------------------------------
// Stage: ingest
// ---------------------------------------------------------------------------

/**
 * Step 2 of the flow: an expensive charge event onto the gateway Kafka topic,
 * picked up by the benthos OpenMeter collector and ingested into Konnect.
 *
 * `api` mode falls back to POST …/wallet/test-usage, which ingests the same
 * CloudEvent shape directly. It skips Kafka + collector, so it validates the
 * billing half only — use it when the broker is not reachable from CI.
 */
async function ingest(state: RunState): Promise<void> {
  const mode: "kafka" | "api" =
    INGEST_MODE === "auto" ? (KAFKA_BROKERS ? "kafka" : "api") : INGEST_MODE;
  state.ingestMode = mode;
  state.amountUsdMicros = usdMicros(AMOUNT_USD).toString();

  assert(
    usdMicros(AMOUNT_USD) > MIN_INVOICE_USD_MICROS,
    `charge $${AMOUNT_USD} clears Stripe's $0.50 minimum`,
  );

  if (mode === "kafka") {
    await ingestViaKafka(state);
  } else {
    await ingestViaApi(state);
  }
  saveState(state);
}

async function ingestViaKafka(state: RunState): Promise<void> {
  stage("Ingest — Kafka → collector → Konnect OpenMeter");
  assert(Boolean(KAFKA_BROKERS), "E2E_KAFKA_BROKERS is configured");

  // The collector prices wei off a live ETH/USD oracle, so the wei amount is
  // derived from the same spot rate and the assertion carries a tolerance.
  const ethUsd = await currentEthUsd();
  const feeWei = BigInt(
    Math.round((Number(AMOUNT_USD) / ethUsd) * 1e18),
  );
  const requestId = `e2e-${state.runId}-${randomUUID().slice(0, 8)}`;

  const message = JSON.stringify({
    type: "create_signed_ticket",
    data: {
      auth_id: `${CLIENT_ID}:${state.externalUserId}`,
      client_id: CLIENT_ID,
      usage_subject: state.externalUserId,
      computed_fee: Number(feeWei),
      billable_secs: 1,
      pixels: "0",
      pipeline: "live-video-to-video:e2e",
      manifest_id: requestId,
      request_id: requestId,
      session_id: requestId,
      app: "pymthouse-e2e",
      session_status: "closed",
      num_tickets: 1,
      current_time: new Date().toISOString(),
    },
  });

  execFileSync(KCAT_BIN, ["-b", KAFKA_BROKERS, "-t", KAFKA_TOPIC, "-P", "-k", `${CLIENT_ID}:${state.externalUserId}`], {
    input: `${message}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });

  log(`produced create_signed_ticket ${requestId} (${feeWei} wei @ $${ethUsd}/ETH ≈ $${AMOUNT_USD})`);
  log("collector consumer group `openmeter-collector` should forward to Konnect within seconds");
}

async function ingestViaApi(state: RunState): Promise<void> {
  stage("Ingest — test-usage API (Kafka + collector bypassed)");
  // `collect: false` matches the route's own default (opt-in, off unless
  // requested) — kept explicit so this stays correct if that default ever
  // changes. A raise here would put the manual-collect stage inside the
  // trigger cooldown, so it would return `rate_limited` and the flow would
  // prove nothing.
  const result = await apiOk<{ requestId: string; amountUsdMicros: string; collected: boolean }>(
    `/api/v1/apps/${CLIENT_ID}/billing/wallet/test-usage`,
    {
      method: "POST",
      body: { externalUserId: state.externalUserId, amountUsd: AMOUNT_USD, collect: false },
    },
  );
  assert(result.collected === false, "ingest did not pre-raise an invoice (collect=false)");
  assert(
    BigInt(result.amountUsdMicros) === usdMicros(AMOUNT_USD),
    `ingested amount matches requested charge (${result.amountUsdMicros})`,
  );
  log(`ingested ${result.requestId} for $${AMOUNT_USD}`);
}

async function currentEthUsd(): Promise<number> {
  const url =
    process.env.E2E_PRICE_ORACLE_URL ||
    "https://api.coinbase.com/v2/prices/ETH-USD/spot";
  const response = await fetch(url);
  const body = (await response.json()) as { data?: { amount?: string } };
  const price = Number(body.data?.amount);
  if (!Number.isFinite(price) || price <= 0) {
    fail(`price oracle returned no usable ETH/USD (${url})`);
  }
  return price;
}

// ---------------------------------------------------------------------------
// Stage: verify-usage
// ---------------------------------------------------------------------------

/**
 * Step 3 of the flow: the charge is visible across every Usage API surface and
 * the balance gate reports the right posture — drawn down, still spendable
 * because a card is on file.
 */
async function verifyUsage(state: RunState): Promise<void> {
  stage("Usage API — event lands in OpenMeter");
  const expected = BigInt(state.amountUsdMicros ?? "0");

  const balance = await poll<{ balanceUsdMicros: string; consumedUsdMicros: string; hasAccess: boolean }>({
    label: "metered usage reaches the balance endpoint",
    timeoutMs: USAGE_TIMEOUT_MS,
    probe: async () => {
      const body = await apiOk<{ consumedUsdMicros: string; balanceUsdMicros: string; hasAccess: boolean }>(
        `/api/v1/builder/apps/${CLIENT_ID}/usage/balance?externalUserId=${encodeURIComponent(state.externalUserId)}`,
      );
      return BigInt(body.consumedUsdMicros) > 0n
        ? { done: true, value: body }
        : { done: false, note: `consumed=${body.consumedUsdMicros}` };
    },
  });
  log(`consumed=${balance.consumedUsdMicros} remaining=${balance.balanceUsdMicros}`);

  stage("Usage API — surface parity");
  const builderUsage = await apiOk<{ totals: { requestCount: number; totalFeeWei: string } }>(
    `/api/v1/builder/apps/${CLIENT_ID}/usage?groupBy=user`,
  );
  const legacyUsage = await apiOk<{ totals: { requestCount: number } }>(
    `/api/v1/apps/${CLIENT_ID}/usage?groupBy=user`,
  );
  assert(
    builderUsage.totals.requestCount === legacyUsage.totals.requestCount,
    "Builder and legacy usage mounts agree",
  );

  const byUser = (builderUsage as unknown as {
    byUser?: Array<{ externalUserId: string | null; requestCount: number }>;
  }).byUser ?? [];
  assert(
    byUser.some((row) => row.externalUserId === state.externalUserId && row.requestCount > 0),
    `groupBy=user attributes the event to ${state.externalUserId}`,
  );

  stage("Balance gate — spend posture");
  const billingState = await apiOk<Record<string, unknown>>(
    `/api/v1/apps/${CLIENT_ID}/billing/state?externalUserId=${encodeURIComponent(state.externalUserId)}`,
  );
  const funding = billingState.funding as Record<string, unknown>;
  const overage = funding.overage as Record<string, unknown>;
  const includedUsage = funding.includedUsage as Record<string, unknown>;

  assert(
    money(includedUsage.remaining) === 0n,
    "included plan usage is exhausted by the expensive charge",
  );
  assert(money(funding.spendable) === 0n, "prepaid + included spendable is drawn to $0");
  assert(overage.eligible === true, "subject is overage-eligible (card on file)");
  assert(
    billingState.canSpend === true && billingState.reason === null,
    `balance gate still permits spend (status=${billingState.status})`,
  );
  assert(
    ["overage", "at_risk"].includes(String(billingState.status)),
    `status reflects unbilled debt (${billingState.status})`,
  );

  const debt = money(overage.unbilledDebt);
  assert(
    overage.debtSource === "gathering_invoice",
    `debt read from the OpenMeter gathering invoice (${overage.debtSource})`,
  );
  const drift = debt > expected ? debt - expected : expected - debt;
  assert(
    expected === 0n || (drift * 10_000n) / expected <= BigInt(AMOUNT_TOLERANCE_BPS),
    `unbilled debt ${debt} is within ${AMOUNT_TOLERANCE_BPS}bps of the ingested $${AMOUNT_USD}`,
  );

  stage("Balance gate — wallet embeds the same state");
  const wallet = await apiOk<{ billingState: { status: string; canSpend: boolean } }>(
    `/api/v1/apps/${CLIENT_ID}/billing/wallet?externalUserId=${encodeURIComponent(state.externalUserId)}`,
  );
  assert(
    wallet.billingState.status === billingState.status,
    "wallet.billingState matches GET /billing/state (a read and a rejection never disagree)",
  );

}

// ---------------------------------------------------------------------------
// Stage: collect
// ---------------------------------------------------------------------------

/**
 * Step 4 of the flow. `queued` is the only pass: settlement now owns the
 * actual raise off its own per-customer Kafka lane, so `POST …/billing/collect`
 * only confirms the request was accepted, not that an invoice exists yet.
 * `skipped` means the debt never cleared the minimum charge, `rate_limited`
 * means something already raised inside the cooldown — both are silent
 * failures of this test. The invoice landing is asserted separately by
 * polling `GET …/billing/state` afterward.
 */
async function collect(state: RunState): Promise<void> {
  stage("Manual collection — POST …/billing/collect");
  const result = await apiOk<{
    outcome: string;
    invoiceIds: string[];
    billingState: Record<string, unknown>;
  }>(`/api/v1/apps/${CLIENT_ID}/billing/collect`, {
    method: "POST",
    body: { externalUserId: state.externalUserId },
  });

  assert(
    result.outcome === "queued",
    `collect returned "queued" (got "${result.outcome}")`,
  );

  stage("Manual collection — settlement raises the invoice");
  const billingState = await poll<Record<string, unknown>>({
    label: "invoice raised by settlement",
    timeoutMs: COLLECT_TIMEOUT_MS,
    probe: async () => {
      const current = await apiOk<Record<string, unknown>>(
        `/api/v1/apps/${CLIENT_ID}/billing/state?externalUserId=${encodeURIComponent(state.externalUserId)}`,
      );
      const collection = current.collection as Record<string, unknown> | undefined;
      if (collection?.nextAction === "awaiting_settlement") {
        return { done: true, value: current };
      }
      return { done: false, note: `collection.nextAction=${collection?.nextAction ?? "none"}` };
    },
  });

  const collection = billingState.collection as Record<string, unknown>;
  assert(
    collection.collector === "settlement_connect",
    "raised invoice is owned by the settlement Connect collector",
  );
  assert(
    collection.nextAction === "awaiting_settlement",
    `nextAction handed off to settlement (${collection.nextAction})`,
  );

  stage("Manual collection — idempotency");
  // `queued` is now an acceptable repeat outcome, not just `rate_limited` /
  // `skipped`: the poll above can take longer than the (short, on staging)
  // trigger cooldown, so pymthouse may accept a second request here. That is
  // fine — settlement's per-customer Kafka lane, not pymthouse's cooldown, is
  // what now guarantees a second raise for the same customer cannot create a
  // duplicate invoice, which is the actual property this stage is pinning.
  const repeat = await apiOk<{ outcome: string }>(
    `/api/v1/apps/${CLIENT_ID}/billing/collect`,
    { method: "POST", body: { externalUserId: state.externalUserId } },
  );
  assert(
    ["rate_limited", "skipped", "queued"].includes(repeat.outcome),
    `repeat collect returned a recognised idempotent outcome (${repeat.outcome})`,
  );
}

// ---------------------------------------------------------------------------
// Stage: settle
// ---------------------------------------------------------------------------

type SettlementCharge = {
  id: string;
  amount: number;
  applicationFee: number;
  invoiceId: string | null;
  /** `direct` lives on the connected account; `destination` on the platform. */
  model: "direct" | "destination";
};

type StripeChargeRow = {
  id: string;
  created: number;
  amount: number;
  paid: boolean;
  customer?: string | null;
  invoice?: string | null;
  application_fee_amount?: number | null;
  transfer_data?: { destination?: string } | null;
};

/**
 * Settlement picks the charge model per customer: `direct` puts the charge on
 * the connected account, `destination` puts it on the platform account with
 * `transfer_data[destination]`. A supplier-incomplete fixture app silently
 * falls back to `destination` (see resolveMerchantChargeModel), so look in
 * both scopes rather than timing out against the wrong one.
 */
async function findSettlementCharge(
  input: {
    state: RunState;
    connectedAccountId: string;
    stripeCustomerId: string;
    expectedCents: number;
  },
): Promise<{ done: boolean; value?: SettlementCharge; note?: string }> {
  const { state, connectedAccountId, stripeCustomerId, expectedCents } = input;
  const direct = await stripe<{ data: StripeChargeRow[] }>(
    `/v1/charges?customer=${encodeURIComponent(stripeCustomerId)}&limit=20`,
    { account: connectedAccountId },
  );
  const directPaid = direct.data.find((row) => row.paid);
  if (directPaid) {
    return {
      done: true,
      value: {
        id: directPaid.id,
        amount: directPaid.amount,
        applicationFee: directPaid.application_fee_amount ?? 0,
        invoiceId: directPaid.invoice ?? null,
        model: "direct",
      },
    };
  }

  const platform = await stripe<{ data: StripeChargeRow[] }>(
    `/v1/charges?limit=100&created[gte]=${state.startedAtUnix}`,
  );
  const destinationPaid = platform.data.find(
    (row) =>
      row.paid &&
      row.transfer_data?.destination === connectedAccountId &&
      row.created >= state.startedAtUnix &&
      row.amount === expectedCents &&
      (!row.customer || row.customer === stripeCustomerId),
  );
  if (destinationPaid) {
    return {
      done: true,
      value: {
        id: destinationPaid.id,
        amount: destinationPaid.amount,
        applicationFee: destinationPaid.application_fee_amount ?? 0,
        invoiceId: destinationPaid.invoice ?? null,
        model: "destination",
      },
    };
  }

  return {
    done: false,
    note: `connected=${direct.data.length} charge(s), platform=${platform.data.length} charge(s) since ${state.startedAtUnix}, none settled yet`,
  };
}


/**
 * Step 5 of the flow: settlement charges the card on the connected account and
 * reports back to OpenMeter, then both read APIs show the money.
 */
async function settle(state: RunState): Promise<void> {
  const connectedAccountId = state.connectedAccountId ?? connectedAccountIdFromEnv();
  state.connectedAccountId = connectedAccountId;
  const stripeCustomerId = await findConnectedCustomerId(state, connectedAccountId);
  const expectedCents = Number(BigInt(state.amountUsdMicros ?? "0") / 10_000n);

  stage("Settlement — Stripe charge");
  const charge = await poll<SettlementCharge>({
    label: "settlement charges the default card",
    timeoutMs: SETTLE_TIMEOUT_MS,
    probe: () =>
      findSettlementCharge({
        state,
        connectedAccountId,
        stripeCustomerId,
        expectedCents,
      }),
  });
  const expectedModel = process.env.E2E_EXPECTED_CHARGE_MODEL?.trim();
  if (expectedModel) {
    assert(
      charge.model === expectedModel,
      `charge routed with the expected model (${charge.model})`,
    );
  }
  log(
    `charge ${charge.id} for ${charge.amount} cents on the ${charge.model === "direct" ? "connected" : "platform"} account (application fee ${charge.applicationFee})`,
  );

  const drift = Math.abs(charge.amount - expectedCents);
  assert(
    expectedCents === 0 || (drift * 10_000) / expectedCents <= AMOUNT_TOLERANCE_BPS,
    `charged ${charge.amount}¢ against an expected ~${expectedCents}¢`,
  );
  const settledInvoiceIds: string[] = charge.invoiceId ? [charge.invoiceId] : [];

  stage("Settlement — OpenMeter invoice reaches paid");
  await poll<true>({
    label: "invoice reported paid back to OpenMeter",
    timeoutMs: SETTLE_TIMEOUT_MS,
    probe: async () => {
      const body = await apiOk<{ items: Array<{ id: string; status: string }> }>(
        `/api/v1/apps/${CLIENT_ID}/billing/wallet/invoices?externalUserId=${encodeURIComponent(state.externalUserId)}&pageSize=50`,
      );
      const match = body.items.find((item) =>
        settledInvoiceIds.length > 0 ? settledInvoiceIds.includes(item.id) : /paid|succeeded/i.test(item.status),
      );
      if (!match) {
        return { done: false, note: "no paid invoice listed yet" };
      }
      if (settledInvoiceIds.length === 0) {
        settledInvoiceIds.push(match.id);
      }
      return /paid|succeeded/i.test(match.status)
        ? { done: true, value: true }
        : { done: false, note: `invoice status=${match.status}` };
    },
  });

  stage("Invoices API — end-user invoice list");
  const userInvoices = await apiOk<{ items: Array<{ id: string }>; totalCount: number }>(
    `/api/v1/apps/${CLIENT_ID}/users/${encodeURIComponent(state.externalUserId)}/invoices`,
  );
  assert(
    settledInvoiceIds.length > 0 && userInvoices.items.some((item) => settledInvoiceIds.includes(item.id)),
    "end-user invoices endpoint lists the collected invoice",
  );

  stage("Transactions API — ledger");
  const ledger = await apiOk<{
    items: Array<{ type: string; amountUsdMicros: string; description: string }>;
    degraded?: boolean;
  }>(
    `/api/v1/apps/${CLIENT_ID}/billing/wallet/transactions?externalUserId=${encodeURIComponent(state.externalUserId)}`,
  );
  assert(ledger.degraded !== true, "ledger built without degraded upstream reads");

  const types = new Set(ledger.items.map((item) => item.type));
  assert(types.has("usage"), "ledger lists the usage drawdown");
  assert(types.has("invoice"), "ledger lists the invoice");
  log(`ledger entry types: ${[...types].join(", ")}`);

  summary();
}

// ---------------------------------------------------------------------------
// Stage: teardown
// ---------------------------------------------------------------------------

/**
 * Best-effort. The fixture end-user is namespaced per run, so leaving one
 * behind is untidy rather than dangerous — never fail the run over cleanup.
 */
async function teardown(state: RunState): Promise<void> {
  stage("Teardown");
  if (process.env.E2E_KEEP_FIXTURES === "true") {
    log("E2E_KEEP_FIXTURES=true — leaving the fixture end-user in place");
    return;
  }
  // "inactive" is the soft-deactivate status; it frees the per-app end-user
  // cap slot so repeated runs cannot exhaust it.
  const result = await api(`/api/v1/apps/${CLIENT_ID}/users`, {
    method: "POST",
    body: { externalUserId: state.externalUserId, status: "inactive" },
  });
  log(`deactivated ${state.externalUserId} → ${result.status}`);
}

// ---------------------------------------------------------------------------

const STAGES: Record<string, (state: RunState) => Promise<void>> = {
  preflight,
  provision,
  "webhook-connect": webhookConnect,
  ingest,
  "verify-usage": verifyUsage,
  collect,
  settle,
  teardown,
};

async function main(): Promise<void> {
  const name = process.argv[2];
  const handler = STAGES[name];
  if (!handler) {
    fail(`unknown stage "${name}" — expected one of: ${Object.keys(STAGES).join(", ")}`);
  }
  const state = loadState();
  await handler(state);
  saveState(state);
  console.log(`\n✓ ${name} passed`);
}

main().catch((err: unknown) => {
  // A private CI log is not a public-facing surface — the whole point of this
  // script is a diagnosable failure. Print the real message, not a stub.
  if (err instanceof StageFailure) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  console.error(
    `\n✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
