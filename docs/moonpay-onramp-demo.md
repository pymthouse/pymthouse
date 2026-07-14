# MoonPay fiat on-ramp local demo

Short local demonstration of Turnkey Wallet Kit + MoonPay sandbox funding an app
owner's prepaid OpenMeter credits in pymthouse.

Phase 1 credits **prepaid USD** via Konnect after MoonPay clears. Moving ETH
to the Arbitrum remote signer / TicketBroker deposit is **phase 2** (chain +
sweep work).

## Prerequisites

### Turnkey (dashboard)

- MoonPay sandbox credential configured via Turnkey (`CreateFiatOnRampCredential`)
- Wallet Kit Auth Proxy enabled for your org
- **Social logins** (so every funder gets a wallet): Embedded Wallets → Configuration
  - OAuth **on**
  - Enable **Google** (and/or Apple / Discord / X — GitHub is not a native toggle)
  - **Redirect URL** = your app origin (local: `http://localhost:3001`, not `example.com`)
  - **Allowed Origins** includes that same origin
  - Paste the Google OAuth **Web** client ID into the Google field (or use env below)
  - In Google Cloud Console, authorized redirect URI must match that Redirect URL

Users who need MoonPay / deposit wallets must sign in via **Turnkey Wallet Kit**
(`Sign In / Create Account` on `/login`). Bare NextAuth GitHub/Google does **not**
provision a Turnkey wallet.

### Environment (`.env.local`)

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_ORGANIZATION_ID` | Turnkey org for Wallet Kit |
| `NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID` | Turnkey Auth Proxy config |
| `NEXT_PUBLIC_TURNKEY_OAUTH_REDIRECT_URI` | Optional override if not set in dashboard |
| `NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID` | Optional Google client ID override |
| `DATABASE_URL` | Postgres (Neon/local) |
| `OPENMETER_URL` | Hosted Konnect or self-hosted OpenMeter |
| `OPENMETER_API_KEY` | OpenMeter API key |
| `TURNKEY_ORG_ID` | Server-side status verification on settle |
| `TURNKEY_API_PUBLIC_KEY` | Turnkey API key (settle verification) |
| `TURNKEY_API_PRIVATE_KEY` | Turnkey API private key |

MoonPay API keys live in the **Turnkey dashboard**, not in pymthouse env files.

### Local app

```bash
cd /path/to/pymthouse
npm install
cp .env.example .env.local   # fill values above
npm run db:migrate
npm run dev                    # http://localhost:3001
```

Optional clearinghouse stack (not required for OpenMeter-only demo):

```bash
docker compose -f docker-compose.clearinghouse.railway.yml --env-file .env.local up -d --build
```

No Railway deploy is required for this demo.

## Demo flow

1. Sign in at `/login` with **Turnkey Wallet Kit** (not Google/GitHub only).
2. Open **Billing** (`/billing`).
3. Click **Fund with MoonPay** (sandbox demo uses a fixed **$25** amount).
4. Complete the sandbox purchase in the MoonPay popup window.
5. pymthouse:
   - registers `onramp_sessions` for your owner identity + deposit wallet
   - verifies Turnkey `getOnRampTransactionStatus === COMPLETED`
   - grants Konnect prepaid credits (`source: onramp`, idempotent on session id)
   - refreshes the prepaid strip on Billing
6. Confirm balance increased on Billing and via:

```bash
curl -s "http://localhost:3001/api/v1/me/credits" \
  -H "Cookie: ..." | jq
```

7. Verify DB:

```sql
SELECT id, external_user_id, deposit_wallet_address, status, granted_usd_micros, settled_at
FROM onramp_sessions
ORDER BY created_at DESC
LIMIT 5;
```

## API routes

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/v1/apps/{clientId}/onramp/sessions` | App owner session |
| `POST` | `/api/v1/apps/{clientId}/onramp/sessions/{sessionId}/settle` | App owner session |

Create session body (owner identity and sandbox amount are set **server-side**):

```json
{
  "depositWalletAddress": "0x...",
  "onRampTransactionId": "<turnkey-on-ramp-tx-id>",
  "turnkeyOrganizationId": "<turnkey-sub-org-id>",
  "onrampProvider": "moonpay"
}
```

## Architecture

```mermaid
sequenceDiagram
  participant Owner as AppOwner_Browser
  participant PH as Pymthouse
  participant TK as Turnkey
  participant MP as MoonPay_Sandbox
  participant OM as OpenMeter

  Owner->>TK: httpClient.initFiatOnRamp (deposit wallet)
  Owner->>PH: POST /onramp/sessions
  Owner->>MP: Complete sandbox purchase
  Owner->>TK: poll transaction status
  Owner->>PH: POST /onramp/sessions/:id/settle
  PH->>TK: getOnRampTransactionStatus (server)
  PH->>OM: grantAllowanceUsdMicros (onramp)
```

### Chain note

Turnkey MoonPay delivers crypto to the **deposit wallet** on **Ethereum** (or Base).
The pymthouse remote signer operates on **Arbitrum One**. Bridging and sweeping to
`fundDepositAndReserve` is documented below as phase 2.

## Phase 2 (not implemented)

| Piece | Approach |
| --- | --- |
| Per-user deposit wallet | Provision Turnkey wallet per `app_users` row; persist `deposit_wallet_address` |
| End-user self-serve | Embed Wallet Kit in integrator apps; same session/settle APIs |
| Automated ETH deposits | Extend `shouldProcessTurnkeyDeposit` to watch registered deposit addresses |
| Attribution | Map deposit address → `(clientId, externalUserId)` |
| Move to signer | Turnkey-signed sweep + bridge to Arbitrum signer |
| TicketBroker credit | Reuse `executeTurnkeyFunding` after ETH lands on signer |

```mermaid
flowchart LR
  subgraph phase2 [Phase2]
    EU[EndUser]
    DW[DepositWallet]
    MP[MoonPay_or_AutoETH]
    WH[turnkey_balance_webhook]
    SW[Sweep_to_Signer]
    TB[TicketBroker]
    OM[OpenMeter]
  end

  EU --> MP --> DW
  DW --> WH
  WH -->|externalUserId| SW
  SW --> TB
  WH --> OM
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No fund panel on Usage | You must be the **app owner** and logged in |
| Turnkey not configured | `NEXT_PUBLIC_ORGANIZATION_ID` + `NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID` |
| Popup blocked / no confirmation | Hard-refresh; panel opens checkout on click and keeps polling even if the tab handle is null |
| `transaction does not belong to organization` | Status must use the Wallet Kit **sub-org** id (session `organizationId`), not the parent org |
| Settle 503 | `TURNKEY_ORG_ID` (or `NEXT_PUBLIC_ORGANIZATION_ID`) + API keys on server |
| Allowance unchanged | `OPENMETER_URL` / API key; Konnect uses `POST /customers/{ulid}/credits/grants` (not entitlement grants) |
| Settle 404 on `.../entitlements/.../grants` | Wrong Konnect path — fixed via prepaid credit grants API |
| `below_min_fund` on signer | Unrelated — that's Arbitrum signer webhook, not this demo |

## Related docs

- [Turnkey balance → TicketBroker funding](./turnkey-ticket-funding.md)
- [Builder API allowances](./builder-api.md)
- [OpenMeter + Railway clearinghouse](./openmeter-railway.md)
