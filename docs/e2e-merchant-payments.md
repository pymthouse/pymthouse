# E2E: merchant Stripe Connect webhook + payment flow (staging)

Runbook for [`.github/workflows/e2e-merchant-payments.yml`](../.github/workflows/e2e-merchant-payments.yml)
and its driver [`scripts/e2e/merchant-payments.ts`](../scripts/e2e/merchant-payments.ts).

Companion to [`adr-stripe-connect-openmeter-webhooks.md`](./adr-stripe-connect-openmeter-webhooks.md)
(what the planes are) and [`builder-api.md`](./builder-api.md) (what the routes return).
The settlement half is documented in
[pymthouse/settlement `docs/e2e-konnect-fake-stripe.md`](https://github.com/pymthouse/settlement/blob/main/docs/e2e-konnect-fake-stripe.md).

---

## What this proves

The settlement e2e in `pymthouse/settlement` runs the worker against `stripefake`.
It proves the invoice lifecycle. It cannot prove that a **real** Stripe Connect
sandbox charge clears against a card a **real** Builder API call attached, or
that pymthouse's own read APIs then agree about what happened.

This workflow closes that gap. Every hop is the deployed staging stack:

```
POST …/users                        → app user provisioned
POST …/users/{eu}/subscription/change → pay-per-use plan (Konnect)
Stripe sandbox: attach pm_ to cus_  → payment_method.attached  ─┐
POST /webhooks/stripe (signed)      → account.updated           ├─ Plane B
                                                                ─┘
kcat → livepeer-gateway-events      → benthos openmeter-collector
                                    → Konnect /events (CloudEvent)
GET  …/usage, …/usage/balance,
     …/billing/state, …/billing/wallet → metering + balance gate
POST …/billing/collect              → settlement /requests/collect (Kafka lane)
                                       → OpenMeter invoicePendingLines + advance
OpenMeter invoice notification      → settlement producer → Kafka → worker  ─┐
worker                              → Stripe Connect off-session charge      ├─ Plane C
worker                              → custom-invoicing payment/status        ─┘
GET  …/wallet/invoices, …/users/{eu}/invoices,
     …/wallet/transactions          → invoice + ledger
```

---

## Isolation model — read this before adding secrets

**Settlement, Kafka and Konnect are shared across preview and production.** There is
no separate settlement deployment to point at, so isolation is by *data*, not by
infrastructure:

| Boundary | Mechanism |
| --- | --- |
| Tenant | A dedicated fixture app (`E2E_CLIENT_ID`) in `billing_mode=merchant` |
| Money | A dedicated **Stripe sandbox** account and its own connected account |
| Subject | A fresh namespaced end-user per run: `e2e-merchant-<run id>-<epoch ms>` |
| Blast radius | `preflight` hard-refuses a production base URL or a live (`sk_live_`) key |

A fresh subject per run is not cosmetic. The invoice trigger holds a per-subject
cooldown (`INVOICE_TRIGGER_COOLDOWN_SECONDS`, default 60s) and included plan usage
resets monthly — reusing one fixture user would make `collect` return
`rate_limited` on the second run of the hour and `skipped` once the allowance
drifts. `concurrency: e2e-merchant-payments` with `cancel-in-progress: false`
enforces the same thing across runs.

The cost is Konnect customer sprawl: one customer per run, forever. Budget for a
reaper (or a monthly sweep of `e2e-merchant-*` subjects) before turning the
nightly schedule on.

---

## Configuration

### Environment `e2e / staging` — secrets

| Secret | Value |
| --- | --- |
| `E2E_M2M_CLIENT_SECRET` | Fixture app's `m2m_*` client secret. `authorizeOwnerWalletM2m` rejects the public/web sibling clients, so this must be the backend helper credential or every wallet route answers `404`. |
| `E2E_STRIPE_SECRET_KEY` | **Sandbox** key. Preflight refuses anything that is not `sk_test_` / `rk_test_`. |
| `E2E_STRIPE_CONNECT_WEBHOOK_SECRET` | The `whsec_…` of the Connect endpoint that staging verifies against. Must match staging's `STRIPE_CONNECT_WEBHOOK_SECRET`, or the synthetic `account.updated` is rejected. |

### Environment `e2e / staging` — variables

| Variable | Value |
| --- | --- |
| `E2E_BASE_URL` | `https://staging.pymthouse.com` |
| `E2E_CLIENT_ID` | Fixture app public client id (`app_…`) |
| `E2E_M2M_CLIENT_ID` | Fixture app M2M client id |
| `E2E_STRIPE_CONNECTED_ACCOUNT_ID` | `acct_…`, onboarded once by hand in the sandbox |
| `E2E_PLAN_ID` | Optional. Otherwise the first `type=usage, status=active` plan on the app |
| `E2E_KAFKA_BROKERS` | Optional `host:port` of the staging Redpanda TCP proxy. Present → `kafka` ingest; absent → `api` ingest |
| `E2E_KAFKA_TOPIC` | Optional; defaults to `livepeer-gateway-events` |
| `E2E_EXPECTED_CHARGE_MODEL` | Optional `direct` / `destination`. Set it to fail the run when settlement routes the charge the other way; unset, the model is only reported |

### Repository variable

`E2E_MERCHANT_PAYMENTS=true` enables the nightly schedule. `workflow_dispatch`
and `workflow_call` always run.

### Staging deployment prerequisites

| Setting | Why |
| --- | --- |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Plane B verification (`src/lib/stripe/webhook.ts`) |
| Stripe Dashboard → Connect endpoint → `/webhooks/stripe` | `account.updated` + `payment_method.attached` delivery |
| `OPENMETER_CUSTOM_INVOICING_APP_ID`, `OPENMETER_MERCHANT_BILLING_PROFILE_ID` | Merchant invoices land on the non-charging Custom Invoicing profile, not the OM Stripe app |
| `SETTLEMENT_OPENMETER_WEBHOOK_URL` bootstrapped | `npm run openmeter:custom-invoicing:bootstrap` — without it OpenMeter never notifies settlement and `settle` times out |
| `PYMTHOUSE_ENABLE_WALLET_TEST_USAGE=1` | **Only** for `api` ingest mode. The route 404s under `NODE_ENV=production` without it, and Vercel Preview is a production build |
| `ACTIVATION_GATE_MODE` | If `enforce_revenue`/`enforce`, the fixture app must be Connect-ready or `provision` fails the sell gate |

---

## The five stages

### 1. Default payment method + pay-per-use subscription (`provision`)

Upserts the end-user, switches it onto the pay-per-use plan, then attaches a
sandbox card.

The hosted setup Checkout page cannot run headless, so the driver calls
`POST …/wallet/payment-methods` **only for its side effect** — that call runs
`ensureMerchantOwnedStripeCustomer`, materialising the customer on the connected
account with `metadata.pymthouse_client_id` / `metadata.external_user_id`. The
driver finds that customer through Stripe's search API, creates a `tok_visa`
payment method on the connected account and attaches it.

That attach emits a **real** `payment_method.attached` Connect webhook, which is
the point: the billing-profile restore path runs against a genuine Stripe
delivery, not a replay. `PATCH …/wallet/payment-methods {ensureDefault:true}`
then promotes it, and the stage asserts `paymentMethod.hasDefault === true` plus
`collection.collector === "settlement_connect"` — the check that the subject is
on the merchant rail rather than the owner OM Stripe app.

### 2. Expensive charge event → Kafka → collector → Konnect (`ingest`)

`kafka` mode produces a `create_signed_ticket` message onto
`livepeer-gateway-events` with `kcat`, in exactly the wire shape go-livepeer's
remote signer emits (`data.auth_id = "<clientId>:<externalUserId>"`,
`data.computed_fee` in wei). The benthos collector consumer group
`openmeter-collector` prices it against the ETH/USD oracle and POSTs a
CloudEvent to Konnect.

Because the collector prices off a live oracle, the driver derives `computed_fee`
from the same spot rate and asserts the resulting debt within
`E2E_AMOUNT_TOLERANCE_BPS` (default 1000 = 10%). Exact-cent assertions are not
available on this path and asking for them would make the job flaky.

`api` mode posts to `…/wallet/test-usage` instead, which ingests the same
CloudEvent directly with exact micros. It skips Kafka and the collector, so it
validates the billing half only. Use it when the broker is not reachable from CI.

> `collect: false` on the test-usage body is load-bearing. The route defaults to
> `true`; a raise there would put stage 4 inside the trigger cooldown, so the
> manual collect would return `rate_limited` and the test would pass having
> proved nothing.

**Amount.** The default `$12.00` has to clear three floors simultaneously, or the
flow degrades into a green run that tested nothing:

| Floor | Value | Miss it and… |
| --- | --- | --- |
| Starter included usage | `$5.00` (`OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS`) | no debt accrues, nothing to invoice |
| Invoice lead window | `min(ceiling/2, $5)` | the trigger never fires |
| Stripe minimum charge | `$0.50` (`MIN_INVOICE_USD_MICROS`) | `collect` returns `skipped` |

### 3. Usage APIs + balance gate (`verify-usage`)

Polls `GET …/usage/balance` until the metered event lands (metering is eventually
consistent — poll to a deadline, never `sleep`), then asserts:

- Builder mount `/api/v1/builder/apps/{id}/usage` and the legacy `/api/v1/apps/{id}/usage`
  alias return the same `totals.requestCount`;
- `groupBy=user` attributes the request to the fixture `externalUserId`;
- `funding.includedUsage.remaining === 0` and `funding.spendable === 0`;
- `overage.eligible === true`, `canSpend === true`, `reason === null`,
  `status ∈ {overage, at_risk}`;
- `overage.debtSource === "gathering_invoice"` — a fallback to `meter_estimate`
  or `unavailable` means OpenMeter never built the gathering invoice, which
  would make stage 4 meaningless;
- `wallet.billingState.status` equals `GET …/billing/state`'s `status`.

That combination *is* the balance gate assertion: credit is exhausted, and the
subject is still permitted to spend precisely because a card is on file.

### 4. Manual collection (`collect`)

Settlement owns the actual raise now (its own per-customer Kafka lane calls
OpenMeter `invoicePendingLines`, not pymthouse), so `POST …/billing/collect`
must return `outcome: "queued"` — that only confirms settlement accepted the
request, not that an invoice exists yet. `skipped` and `rate_limited` fail the
stage — they are the two ways this test silently stops testing anything.

The stage then polls `GET …/billing/state` until `collection.nextAction ===
"awaiting_settlement"`, which is the actual assertion that settlement raised
the invoice. It then calls collect a second time and requires `rate_limited`,
`skipped`, or `queued` — a second `queued` is expected here (the poll above
usually outlasts the trigger cooldown) and is fine: settlement's Kafka lane,
not pymthouse's cooldown, is what now guarantees the second request cannot
raise a duplicate invoice.

### 5. Charge, invoices, transactions (`settle`)

Polls the Stripe sandbox for a paid charge (amount within tolerance,
application fee recorded), then polls
`GET …/wallet/invoices` until the raised invoice reads `paid` — that transition
only happens once the settlement worker has called
`POST …/apps/custom-invoicing/{id}/payment/status`, so it is the assertion that
Plane C closed the loop.

> **Where the charge lives depends on the charge model.** `prepareAppCustomerStripeBilling`
> stamps `stripe_charge_model` on the OpenMeter customer: `direct` when the
> Connect supplier is complete (charge on the connected account), otherwise it
> falls back to `destination` (charge on the platform account with
> `transfer_data[destination]`) and logs a warning. The driver searches both
> scopes rather than timing out against the wrong one, and reports which model
> settled. Pin it with `E2E_EXPECTED_CHARGE_MODEL` once the fixture app's
> supplier is known-complete — a silent flip to `destination` is a real
> regression worth failing on.

Then `GET …/users/{eu}/invoices` must list the invoice, and
`GET …/wallet/transactions` must be non-`degraded` and contain both `usage` and
`invoice` entries.

> Ledger entry types are `credit_purchased | usage | invoice | refund`
> (`src/lib/billing/transactions-ledger.ts`). There is no separate `payment` or
> `credit` type — a settled charge appears as the `invoice` entry, and
> `credit_purchased` only appears if the fixture user was topped up. If you want
> a `credit_purchased` row asserted too, add a `…/wallet/top-up` step before
> ingest; the current workflow does not, because a top-up would fund the usage
> and stop the overage path from ever being reached.

---

## Running it locally

```bash
export E2E_STATE_FILE=/tmp/merchant-payments.json
export E2E_BASE_URL=https://staging.pymthouse.com
export E2E_CLIENT_ID=app_…
export E2E_M2M_CLIENT_ID=m2m_…
export E2E_M2M_CLIENT_SECRET=pmth_cs_…
export E2E_STRIPE_SECRET_KEY=sk_test_…
export E2E_STRIPE_CONNECT_WEBHOOK_SECRET=whsec_…
export E2E_STRIPE_CONNECTED_ACCOUNT_ID=acct_…
export E2E_INGEST_MODE=api          # or kafka, with E2E_KAFKA_BROKERS set

for stage in preflight provision webhook-connect ingest verify-usage collect settle; do
  npm run e2e:merchant-payments -- "$stage" || break
done
npm run e2e:merchant-payments -- teardown
```

Stages share `E2E_STATE_FILE`; delete it to start a run with a fresh end-user.
Set `E2E_EXTERNAL_USER_ID` to re-attach to an existing fixture (mind the
cooldown), and `E2E_KEEP_FIXTURES=true` to skip teardown while debugging.

---

## Failure triage

| Symptom | Cause |
| --- | --- |
| Every wallet route `404` | `E2E_M2M_CLIENT_ID` is the public or web sibling, not the app's configured `m2m_*` client |
| `provision` fails the sell gate | `ACTIVATION_GATE_MODE` is enforcing and the fixture app is not Connect-ready |
| `webhook-connect` gets `400` | Staging's `STRIPE_CONNECT_WEBHOOK_SECRET` differs from `E2E_STRIPE_CONNECT_WEBHOOK_SECRET` |
| `webhook-connect` returns `clientId: null` | The connected account is not bound to the fixture app's `app_billing_config` row |
| `verify-usage` times out (kafka mode) | Collector down, oracle warm-up failing, or the message key/`auth_id` does not resolve to the subject. Check the collector logs for `signed_ticket mapping failed` |
| `verify-usage` times out (api mode) | `PYMTHOUSE_ENABLE_WALLET_TEST_USAGE` unset on a production build → the route 404s |
| `debtSource: "meter_estimate"` | OpenMeter has no gathering invoice for the customer — merchant billing profile not assigned |
| `collect` → `skipped` | Debt under `$0.50`, or included usage still covers it — raise `E2E_AMOUNT_USD` |
| `collect` → `rate_limited` on the first call | A previous run used this subject inside the cooldown, or ingest ran with `collect: true` |
| `settle` times out on the Stripe charge | Settlement worker not consuming, or OpenMeter notifications not bootstrapped to the producer |
| `settle` sees the charge but not `paid` | Worker charged but the `payment/status` callback to OpenMeter failed — check the settlement DLQ topic |
| Charge reported with `model: destination` | The fixture app's Connect supplier is incomplete, so `resolveMerchantChargeModel` fell back — finish the supplier sync if you expected `direct` |

---

## Deliberate scope limits

- **Plane A (owner cost rail) is not covered.** Different profile, different
  collector; it deserves its own job rather than a branch inside this one.
- **Connect onboarding is not covered.** Account Links need a browser, so the
  connected account is provisioned once by hand and this workflow asserts its
  readiness rather than creating it.
- **The gateway is not in the loop.** `ingest` synthesises the signed-ticket
  message that go-livepeer's remote signer would emit. Validating the signer
  itself belongs with the clearinghouse stack.
- **This never runs on pull requests.** It spends sandbox money, mutates shared
  Konnect state and needs environment secrets — `workflow_dispatch`, a gated
  nightly schedule, and `workflow_call` from the staging deploy are the intended
  triggers.
