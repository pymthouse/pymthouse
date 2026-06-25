# On-chain ETH deposits (shared signer)

PymtHouse clears inbound **Arbitrum** deposits to the **shared company signer** using a **fund-first** pipeline: TicketBroker `fundDeposit` on-chain is the source of truth; OpenMeter allowance is credited only after the broker tx is confirmed.

## Flow (fund-first)

1. User sends **ETH** or **USDC** on Arbitrum from their Turnkey login wallet to the shared signer.
2. Turnkey emits `BALANCE_FINALIZED_UPDATES` (`operation: deposit`, `caip2: eip155:42161`).
3. `POST /api/v1/webhooks/turnkey/balances` verifies the ed25519 signature (JWKS or env keys).
4. Handler resolves `tx.from` via `eth_getTransactionByHash` on Arbitrum RPC.
5. `from` → `users.walletAddress` or `end_users.walletAddress` (lowercase, unique partial indexes).
6. **USDC ingress:** swap USDC → ETH via Uniswap V3 + Turnkey (`swap-usdc-to-eth.ts`); realized ETH feeds the same machine.
7. **Fund on-chain:** `fundDeposit` / `fundDepositAndReserve` via go-livepeer CLI (`SIGNER_CLI_URL`); `fundTxHash` recorded on `signer_deposit_events`.
8. **Credit entitlement:** ETH → USD micros via `getEthUsdOracle()`; `grantAllowanceUsdMicros({ source: "onchain_deposit" })` only after funding succeeds.
9. Unresolved payers → `signer_deposit_events` with `status=unmatched` (HTTP 200, no fund/credit).

### Status machine

| Status | Meaning |
|--------|---------|
| `pending` | Row inserted; funding in progress |
| `funded` | Broker funded (`fundTxHash` set); OpenMeter credit pending/retryable |
| `credited` | Fund + credit complete |
| `unmatched` | No wallet mapping for `tx.from` |
| `error` | Permanent failure (invalid amount, fund error persisted) |

Turnkey retries on 5xx. Duplicate `idempotencyKey` is safe: `funded` rows retry credit only; `credited` rows are no-ops.

## x402 pull rail (Base)

Per-request USDC micropayments on **Base** (`eip155:8453`) complement push deposits:

- Seller: `buildX402PaymentRequiredResponse()` → HTTP 402 + `PAYMENT-REQUIRED` header.
- Facilitator: `POST /api/v1/x402/verify` (EIP-3009 validation), `POST /api/v1/x402/settle` (Turnkey-sponsored `transferWithAuthorization` + ERC-8021 builder-code suffix).
- On settlement: `grantAllowanceUsdMicros({ source: "x402_settlement" })`, USDC 1:1 to USD micros.

## Login / wallet mapping

Every login path must record a unique wallet address:

| Path | Wallet capture |
|------|----------------|
| Turnkey native | `findOrCreateDeveloperUser` on sign-in |
| GitHub / Google | OAuth → `/setup/wallet` → `POST /api/v1/account/link-wallet` |
| App end users (direct) | `findOrCreateEndUser` / `findOrCreateAppEndUser` with Turnkey JWT |
| Platform app (M2M) | `POST /api/v1/apps/{clientId}/users/{externalUserId}/wallet` with end-user `turnkeySessionJwt` |

`turnkeySubOrgId` (`organization_id` JWT claim) is stored on `users` and `end_users` for audit; deposit attribution uses `walletAddress` only.

Developers without an app-scoped `end_users` row are credited via their first owned app using `externalUserId = user:{users.id}` (same convention as RFC 8693 token exchange).

## Webhook registration

```bash
npm run turnkey:register-balance-webhook
# or: npx tsx scripts/register-turnkey-balance-webhook.ts
```

Register **BALANCE_FINALIZED_UPDATES** in Turnkey for the shared signer ETH address pointing at:

`{NEXTAUTH_URL}/api/v1/webhooks/turnkey/balances`

## Environment

| Variable | Purpose |
|----------|---------|
| `NEXTAUTH_URL` | Public base URL for webhook + x402 facilitator |
| `ARBITRUM_RPC_URL` | RPC for `eth_getTransactionByHash` and USDC swap quotes |
| `SIGNER_CLI_URL` | go-livepeer CLI proxy for `fundDeposit` / `fundDepositAndReserve` |
| `SIGNER_RESERVE_FLOOR_WEI` | Reserve floor for `fundDepositAndReserve` split (default 0.01 ETH) |
| `USDC_SWAP_SLIPPAGE_BPS` | Slippage bound for USDC→ETH swap (default 50 = 0.5%) |
| `UNISWAP_ARBITRUM_POOL_FEE` | Uniswap v3 pool fee tier (default 500) |
| `TURNKEY_WEBHOOK_KEY_ID` / `TURNKEY_WEBHOOK_PUBLIC_KEY` | Optional static verification keys (else JWKS) |
| `ETH_USD_PRICE` | Oracle fallback when live/cache unavailable |
| `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` | Server-side Turnkey (attestation, USDC swap, x402 settle) |
| `INGEST_SHARED_SECRET` | Auth for internal `GET /api/v1/internal/deposits/resolve?from=0x...` (clearinghouse) |

## Internal resolve (clearinghouse)

`GET /api/v1/internal/deposits/resolve?from=0x...` with `Authorization: Bearer ${INGEST_SHARED_SECRET}` returns `{ clientId, externalUserId, appId, kind, endUserId?, turnkeyOrgId? }` or 404. Uses the same resolver as the deposit webhook.

## Operations

- **Idempotency:** `x-turnkey-event-id` (preferred) or message `idempotencyKey` → `signer_deposit_events.idempotency_key` UNIQUE.
- **Retries:** Transient fund/OpenMeter failures return 5xx; Turnkey retries safely. `funded` without credit retries grant only.
- **Permanent errors:** Invalid amount etc. → `status=error`, HTTP 200 with note.

M2M users without a recorded `walletAddress` cannot be attributed from on-chain deposits; they continue using existing billing paths.
