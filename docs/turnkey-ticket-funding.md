# Turnkey balance → TicketBroker auto-funding

When ETH lands in the signer wallet on Arbitrum, Turnkey sends `balances:finalized`
webhooks to `POST /webhooks/turnkey-balance`. Pymthouse verifies the signature,
checks the deposit against configured thresholds, and calls the protected signer
CLI route `fundDepositAndReserve` to credit the Livepeer TicketBroker deposit.

Register the webhook:

```bash
npm run turnkey:create-webhook
# or with an explicit URL:
npm run turnkey:create-webhook -- --url https://staging.pymthouse.com/webhooks/turnkey-balance
```

Requires a Turnkey billing org on Pay As You Go, Pro, or Enterprise. Balance
webhooks must be registered from the parent billing organization.

## Minimum deposit requirements

Funding uses two wei thresholds (see `src/lib/turnkey-funding.ts`):

| Env var | Default (wei) | Default (ETH) | Purpose |
| --- | --- | --- | --- |
| `TICKET_FUNDING_GAS_BUFFER_WEI` | `100000000000000` | 0.0001 | Held back so the signer keeps ETH for the on-chain `fundDepositAndReserve` tx |
| `TICKET_FUNDING_MIN_WEI` | `1000000000000000` | 0.001 | Minimum amount credited to TicketBroker after the buffer |
| `RESERVE_AMOUNT` | `250000000000000000` | 0.25 | Target TicketBroker reserve balance. Incoming `fundWei` fills reserve until this amount; once reserve ≥ target, 100% goes to deposit |

Computation:

```
fundWei = depositAmountWei - TICKET_FUNDING_GAS_BUFFER_WEI
```

A deposit is funded only when `fundWei > 0` and `fundWei >= TICKET_FUNDING_MIN_WEI`.

**Minimum incoming deposit (defaults):**

```
TICKET_FUNDING_GAS_BUFFER_WEI + TICKET_FUNDING_MIN_WEI + 1 wei
= 100000000000000 + 1000000000000000 + 1
= 1100000000000001 wei  (~0.0011 ETH)
```

Practical recommendation: send **≥ 0.002 ETH** on Arbitrum One so small rounding
or companion events do not land near the threshold.

Example with defaults for a **0.01 ETH** deposit:

- Deposit: `10000000000000000` wei (0.01 ETH)
- Buffer: `100000000000000` wei (0.0001 ETH)
- Funded to TicketBroker: `9900000000000000` wei (0.0099 ETH)

## Deposit vs reserve allocation

After computing `fundWei`, the webhook reads current TicketBroker reserve via
`getSenderInfo` and splits funds using `RESERVE_AMOUNT` (wei, loaded at config
startup):

```
reserveShortfall = max(0, RESERVE_AMOUNT - currentReserveWei)
reserveWei       = min(fundWei, reserveShortfall)
depositWei       = fundWei - reserveWei
```

- While reserve is below `RESERVE_AMOUNT`, incoming funds fill the shortfall
  first; any remainder goes to deposit.
- Once `currentReserveWei >= RESERVE_AMOUNT`, `reserveWei` is `0` and 100% of
  `fundWei` goes to deposit.
- Default `RESERVE_AMOUNT` is `0.25 ETH` (`250000000000000000` wei). Set `RESERVE_AMOUNT=0` for all-to-deposit behavior.

## Environment variables

Set on **Vercel** (the webhook handler). Vercel builds skip `db:migrate`; apply
migrations to the Preview/Production Neon branch separately.

```bash
# Chain for incoming deposits (Arbitrum One mainnet)
TURNKEY_FUNDING_CAIP2=eip155:42161

# Optional overrides (wei strings)
TICKET_FUNDING_GAS_BUFFER_WEI=100000000000000
TICKET_FUNDING_MIN_WEI=1000000000000000
RESERVE_AMOUNT=250000000000000000

# Signer CLI (required for funding)
SIGNER_CLI_URL=https://<railway-signer>/__signer_cli
```

Also required for webhook registration: `TURNKEY_ORG_ID`, `TURNKEY_API_PUBLIC_KEY`,
`TURNKEY_API_PRIVATE_KEY`.

## Webhook response statuses

| HTTP | JSON `status` | Meaning |
| --- | --- | --- |
| 200 | `funded` | Deposit claimed and `fundDepositAndReserve` succeeded |
| 200 | `ignored` | Valid webhook, intentionally not funded (see `reason`) |
| 401 | `error` | Signature verification failed |
| 500 | `error` | Funding failed after claim (row marked `failed` in DB) |
| 503 | `error` | Signer address unavailable (`getEthAddr` failed) |

Common `ignored` reasons:

| `reason` | Meaning |
| --- | --- |
| `below_gas_buffer` | `depositAmount <= TICKET_FUNDING_GAS_BUFFER_WEI` |
| `below_min_fund` | After buffer, amount is below `TICKET_FUNDING_MIN_WEI` |
| `wrong_address` | Deposit was not to the signer ETH address |
| `not_deposit` | Outgoing / withdraw balance event |
| `already_funded` | Idempotency key already processed |

## Multiple webhooks per deposit

Turnkey may deliver **several** `balances:finalized` events for one user-facing
transfer: the main deposit, internal movements, dust, or unrelated tiny incoming
transfers to the same address. Each delivery has its own `msg.idempotencyKey` and
`msg.asset.amount`.

A `skipped: below_gas_buffer` log does **not** mean a larger deposit failed — it
often means a separate small event was correctly ignored. Check Vercel logs for a
later `decision: fund` / `funded successfully` line and confirm
`turnkey_funding_events.status = 'funded'`.

## Verification checklist

1. Deploy pymthouse with `SIGNER_CLI_URL` pointing at `/__signer_cli` on Railway.
2. Run `npm run db:migrate` against the target Neon branch (Preview vs production
   use different branches — see `scripts/db-migrate.ts` journal notes).
3. Register the webhook: `npm run turnkey:create-webhook`.
4. Send **≥ 0.002 ETH** to the signer address on Arbitrum One.
5. Vercel logs: `[turnkey-balance] funded successfully`.
6. DB: `SELECT * FROM turnkey_funding_events ORDER BY created_at DESC LIMIT 5;`
7. On-chain: Arbiscan shows `fundDepositAndReserve` from the signer to TicketBroker.
8. Signer admin: deposit increased via cli-status / signer dashboard.
