# TurnKey USDC Pre-Authorization for pymthouse

How to use [TurnKey.com](https://www.turnkey.com) to make pymthouse a system where users log in, maintain self-custody wallets, and pre-authorize USDC payments — without pymthouse ever holding any keys.

---

## Current Architecture Recap

pymthouse today is a Next.js app that acts as a clearinghouse for Livepeer transcoding. It has:

- **Privy** for wallet/social login and embedded wallets (but Privy holds key shares — not fully self-custody)
- **Credit-based billing** where `creditBalanceWei` is tracked per end-user in SQLite, and `deductCredits`/`addCredits` in `src/lib/billing.ts` manage an internal ledger
- **OIDC provider** that issues `app_XXXX` client IDs for developer apps (the "outhouse" sub-organization model)
- **go-livepeer signer** on Arbitrum for signing Livepeer micropayment tickets

The key gap: funds are tracked as an internal credit balance, not backed by on-chain custody. Users don't actually self-custody anything — they prepay into the platform's ledger.

---

## How TurnKey Fits In

[TurnKey](https://www.turnkey.com) is an API-based key management infrastructure that lets you create and manage cryptographic wallets without ever holding the private keys yourself. The keys live in secure enclaves; signing requires explicit user authorization via TurnKey's policy engine. This is the critical difference from Privy's embedded wallets (where Privy holds a key share) — with TurnKey, **neither pymthouse nor TurnKey can unilaterally move funds**.

### 1. Self-Custody Wallets via TurnKey Sub-Organizations

TurnKey has a concept of **sub-organizations** that maps perfectly onto pymthouse's developer app model.

**How it works:**

- pymthouse's top-level TurnKey organization is the **root org**. It has API keys to create sub-organizations but *cannot* sign transactions for wallets inside those sub-orgs.
- When a developer creates an app via `POST /api/v1/apps` (which today calls `createAppClient()` to mint an `app_XXXX` client ID), pymthouse would additionally call TurnKey's `createSubOrganization` API to create a TurnKey sub-org for that app.
- When an **end user** signs up within a developer app, pymthouse calls `createWallet` inside that sub-org. The user gets a passkey (WebAuthn credential) that is the *sole authenticator* for their wallet. pymthouse stores the `walletAddress` and `turnkeySubOrgId` on the `endUsers` row, but never holds any key material.

**Mapping to existing code:**

| Current (Privy) | TurnKey Equivalent |
|---|---|
| `findOrCreateEndUser(privyDid, walletAddress)` in `src/lib/privy.ts` | `turnkey.createSubOrganization()` + `turnkey.createWallet()`, store `turnkeySubOrgId` + `walletAddress` on `endUsers` |
| `NEXT_PUBLIC_PRIVY_APP_ID` | `TURNKEY_ORGANIZATION_ID` (root org) |
| `PRIVY_APP_SECRET` | `TURNKEY_API_PUBLIC_KEY` + `TURNKEY_API_PRIVATE_KEY` |
| Privy embedded wallet (key-share model) | TurnKey wallet (enclave model, user-only signing via passkey) |

The sub-organization hierarchy:

```
pymthouse Root Org (TURNKEY_ORGANIZATION_ID)
├── Sub-Org: App "StreamFlix" (app_a1b2c3...)
│   ├── User wallet 0xABC...  (passkey: user's device)
│   ├── User wallet 0xDEF...  (passkey: user's device)
│   └── ...
├── Sub-Org: App "AIStudio" (app_d4e5f6...)
│   ├── User wallet 0x123...
│   └── ...
└── ...
```

Each developer app already gets an OIDC `client_id` from `createAppClient()`. The TurnKey sub-org ID would be stored alongside it, so the existing client-ID-based routing continues to work exactly as it does today.

### 2. USDC Pre-Authorization Smart Contract

This is the core innovation. Instead of users pre-paying credits into pymthouse's ledger (the current `creditBalanceWei` model), you deploy a **USDC pre-authorization contract** that lets users approve a spending limit without transferring custody of funds.

**Contract design (ERC-20 Permit + Allowance pattern):**

```solidity
// Conceptual — deployed on Arbitrum (where pymthouse already operates)
contract UsdcPreAuth {
    IERC20 public usdc; // Arbitrum USDC: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831

    struct Authorization {
        address user;        // wallet owner
        address spender;     // pymthouse's settlement address
        uint256 maxAmount;   // max USDC the spender can pull
        uint256 spent;       // how much has been pulled so far
        uint256 expiresAt;   // unix timestamp
        bool revoked;
    }

    mapping(bytes32 => Authorization) public authorizations;

    // User signs a tx (via TurnKey passkey) to create a pre-auth
    function createAuthorization(
        address spender,
        uint256 maxAmount,
        uint256 duration
    ) external { ... }

    // pymthouse calls this to settle usage (up to the authorized amount)
    function executeCharge(
        bytes32 authId,
        uint256 amount
    ) external onlySpender { ... }

    // User can revoke at any time — they maintain full custody
    function revokeAuthorization(bytes32 authId) external onlyOwner { ... }
}
```

**Why this preserves self-custody:**

- The USDC never leaves the user's wallet until pymthouse actually settles a charge.
- The user sets a cap (`maxAmount`) and an expiry. pymthouse can only pull up to that cap.
- The user can revoke at any time by signing a transaction with their TurnKey passkey.
- pymthouse never holds keys, only a settlement address that the contract recognizes as a valid `spender`.

**Alternatively**, you can use a simpler approach with just ERC-20 `approve()`:

- User calls `USDC.approve(pymthouseSettlementAddr, maxAmount)` — this is a standard ERC-20 allowance.
- pymthouse calls `USDC.transferFrom(userWallet, pymthouseAddr, chargeAmount)` when settling usage.
- The advantage of a custom contract is richer semantics (expiry, revocation, per-session limits, event logs for auditing).

### 3. Ticket Value Tracking and Deduction

Today, pymthouse tracks usage via the `generate-live-payment` proxy endpoint. The flow in `src/app/api/signer/generate-live-payment/route.ts` authenticates the request, verifies the app is approved, then proxies to go-livepeer. The signer proxy decodes the Livepeer protobuf to extract `PriceInfo` and pixel counts.

With TurnKey + USDC pre-auth, the billing flow becomes:

```
1. User creates pre-auth (signs tx via TurnKey passkey)
   → UsdcPreAuth.createAuthorization(pymthouseAddr, 50 USDC, 30 days)

2. User streams video (SDK sends requests to pymthouse)
   → POST /api/signer/generate-live-payment
   → pymthouse decodes Livepeer ticket, computes feeWei from PriceInfo
   → pymthouse converts feeWei (ETH-denominated) to USDC equivalent
   → pymthouse records the USDC charge in `transactions` table
   → pymthouse updates running total against the pre-auth cap

3. Settlement (periodic or per-session)
   → pymthouse calls UsdcPreAuth.executeCharge(authId, totalUsdc)
   → USDC moves from user's wallet to pymthouse's settlement address
   → Transaction marked as "confirmed" with on-chain txHash
```

The key change to `src/lib/billing.ts`: instead of `deductCredits` decrementing an internal SQLite balance, it would:

1. Check the on-chain pre-auth remaining allowance
2. Record the pending charge locally
3. Batch-settle on-chain periodically (to save gas)

### 4. Signing Flow with TurnKey (No Keys Held)

When the user needs to sign something (create a pre-auth, revoke, or any on-chain action), the flow is:

1. pymthouse frontend calls TurnKey's `@turnkey/sdk-browser` to initiate a signing request.
2. The user authenticates with their **passkey** (biometric/hardware key on their device).
3. TurnKey's secure enclave signs the transaction and returns the signed payload.
4. pymthouse submits the signed transaction to Arbitrum RPC.

pymthouse **never sees the private key**. The signing happens entirely within TurnKey's infrastructure, gated by the user's passkey.

### 5. Preserving the Outhouse Sub-Organization / Client ID Model

The existing OIDC client-ID system in `src/lib/oidc/clients.ts` doesn't need to change at all. The `createAppClient()` function would be extended to also provision a TurnKey sub-org:

```typescript
export async function createAppClient(displayName: string): Promise<{
  id: string;
  clientId: string;
  turnkeySubOrgId: string;
}> {
  const id = uuidv4();
  const clientId = generateClientId();

  // Existing OIDC client creation
  db.insert(oidcClients).values({ ... }).run();

  // Create TurnKey sub-organization for this app
  const subOrg = await turnkeyClient.createSubOrganization({
    organizationName: displayName,
    rootUsers: [{ /* app owner's authenticator */ }],
  });

  return { id, clientId, turnkeySubOrgId: subOrg.subOrganizationId };
}
```

The `developerApps` table would get a new `turnkeySubOrgId` column. End users within that app would have their wallets created inside the app's sub-org. This gives each developer app isolated wallet management, exactly like the current OIDC client isolation.

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      pymthouse (Next.js)                          │
│                                                                    │
│  ┌────────────────┐   ┌──────────────┐   ┌──────────────────┐    │
│  │ OIDC Provider   │   │ Billing      │   │ Signer Proxy     │    │
│  │ (app_XXXX IDs)  │   │ (USDC track) │   │ (Livepeer tix)   │    │
│  └────────┬───────┘   └──────┬───────┘   └──────┬───────────┘    │
│           │                  │                   │                  │
│  ┌────────┴──────────────────┴───────────────────┴──────────┐     │
│  │                   SQLite (Drizzle ORM)                     │     │
│  │  users | end_users | transactions | pre_authorizations     │     │
│  └────────────────────────────────────────────────────────────┘     │
└──────────┬──────────────────────┬──────────────────┬───────────────┘
           │                      │                  │
           ▼                      ▼                  ▼
   ┌───────────────┐   ┌──────────────────┐   ┌──────────────┐
   │ TurnKey API    │   │ Arbitrum RPC      │   │ go-livepeer   │
   │                │   │                    │   │ (Docker)      │
   │ Root Org       │   │ UsdcPreAuth.sol   │   │               │
   │ ├─ SubOrg App1 │   │ USDC ERC-20       │   │               │
   │ │  ├─ Wallet1  │   │                    │   │               │
   │ │  └─ Wallet2  │   └──────────────────┘   └──────────────┘
   │ └─ SubOrg App2 │
   │    └─ Wallet3  │
   └───────────────┘
```

---

## What Needs to Change (Component Summary)

| Component | Change |
|---|---|
| `src/lib/privy.ts` | Replace with `src/lib/turnkey.ts` — TurnKey SDK for sub-org/wallet creation |
| `src/components/PrivyProvider.tsx` | Replace with TurnKey passkey-based auth UI (`@turnkey/sdk-react`) |
| `src/db/schema.ts` | Add `turnkeySubOrgId` to `developerApps` and `endUsers`; add `preAuthorizations` table |
| `src/lib/billing.ts` | Replace credit ledger with pre-auth tracking + on-chain settlement calls |
| `src/lib/oidc/clients.ts` | Extend `createAppClient()` to also create TurnKey sub-org |
| Smart contract | New `UsdcPreAuth.sol` on Arbitrum (custom or use standard ERC-20 approve) |
| `src/app/api/signer/generate-live-payment/route.ts` | Add USDC pre-auth balance check before proxying |
| Frontend | Add pre-auth creation/revocation UI, TurnKey passkey enrollment |
| `.env` | Add `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY` |

---

## Key Benefits

1. **True self-custody**: TurnKey wallets are controlled exclusively by the user's passkey. pymthouse cannot move funds unilaterally. This is a meaningful improvement over both Privy (key-share) and the current internal-ledger model.

2. **Pre-auth without custody**: The smart contract pattern means users pre-approve a spending limit but keep their USDC in their own wallet until actual charges are settled. This is analogous to how a credit card pre-authorization works, but on-chain and transparent.

3. **Sub-org isolation preserved**: TurnKey's sub-organization model maps directly onto pymthouse's developer-app / OIDC-client model. Each app gets its own isolated sub-org, and the existing `app_XXXX` client IDs continue to work for OIDC flows.

4. **No keys held anywhere by pymthouse**: pymthouse stores only wallet addresses and TurnKey org IDs. All signing is passkey-gated through TurnKey's enclaves.

5. **On-chain auditability**: Every pre-auth creation, charge, and revocation is an on-chain event. This replaces the opaque internal `transactions` table with verifiable on-chain records (though you'd still keep a local cache for performance).
