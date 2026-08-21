# Ops: production sandbox Merchant Connect

Wire the **staging Stripe sandbox platform** into production so merchant apps can
flip Sandbox on Payments and onboard with test cards, without mixing live money.

## Do not reuse staging webhook secrets

Staging `whsec_` values only verify deliveries to staging URLs. Create **new**
Dashboard endpoints pointed at production hosts and copy those new secrets.

## Checklist

### 1. Sandbox Stripe Dashboard (same account staging uses)

1. Developers → Webhooks → **Add endpoint** (Connect / connected-account events):
   - URL: `https://pymthouse.com/webhooks/stripe/sandbox`
   - Events: at least `account.updated`, plus Checkout / SetupIntent / PM /
     PaymentIntent events the live Connect endpoint already receives
   - Copy signing secret → Vercel Production `STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET`
2. Optional platform endpoint (sandbox top-ups / PM attach on the platform account):
   - Same URL `https://pymthouse.com/webhooks/stripe/sandbox`
   - Copy secret → `STRIPE_SANDBOX_WEBHOOK_SECRET`
3. Settlement producer sandbox ingress:
   - URL: `https://<settlement-producer>/webhooks/stripe/sandbox`
   - Payment / invoice events settlement already listens for on live
   - Copy secret → Railway `SETTLEMENT_STRIPE_SANDBOX_WEBHOOK_SECRETS`

### 2. Copy sandbox API key (not staging whsec)

| Env | Value |
|-----|--------|
| Vercel Production `STRIPE_SANDBOX_SECRET_KEY` | Staging's sandbox `sk_test_…` / restricted key |
| Settlement `SETTLEMENT_STRIPE_SANDBOX_SECRET_KEY` | Same sandbox platform key |

Leave Konnect / `OPENMETER_STRIPE_APP_ID` on the **live** Stripe app. Owner Plane A
stays live; only Merchant Connect (Plane B) uses the sandbox key when
`app_billing_config.stripe_livemode = false`.

Sandbox merchant payers are a **separate** OpenMeter customer:
`sbx_eu_{end_users.id}`. Live merchant wallets stay `eu_{id}`. Test-card
top-ups on the sandbox webhook plane grant prepaid credits onto `sbx_eu_…`
only when that plane matches the app's `stripe_livemode`. Owner top-ups on
the sandbox plane are still ignored — they must not mint production owner
prepaid. Switching Sandbox → Live (or back) is a different customer; the
active balance does not follow.

Sandbox merchant customers pin to the existing OpenMeter **sandbox / free**
billing profile, not Custom Invoicing. Live merchant customers stay on
Custom Invoicing + settlement metadata.

### 3. Smoke

1. On pymthouse.com, create/open a merchant app → Payments. First Connect from
   owner roll-up defaults to **Sandbox**; switch to Live before onboarding if
   you want real charges.
2. Complete Account Link with Stripe test data
3. Attach `pm_card_visa` for an end user
4. Add sandbox credit (Checkout $10). Confirm Konnect prepaid lands on
   `sbx_eu_{end_users.id}`, not production `eu_{id}`
5. `POST …/billing/collect` → settlement charges on the sandbox connected account

### 4. Going live later

Disconnect Connect, switch **Live**, run a new Account Link. Sandbox `acct_` is
not promotable — live is a new connected account on the live platform. The
live end-user payer is `eu_{id}` again (empty until a live top-up); sandbox
`sbx_eu_{id}` prepaid stays on the sandbox customer.
