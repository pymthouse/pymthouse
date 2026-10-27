# PymtHouse docs

Operator and integrator documentation for the
[pymthouse/pymthouse](https://github.com/pymthouse/pymthouse) monorepo. Product
legal pages (Terms, Privacy) for end users are out of scope for this folder unless
linked below; this index tracks **engineering** docs and known gaps in the
legal / compliance / security documentation set.

## Index

| Document | Audience | Topic |
| --- | --- | --- |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Operators | High-level deploy overview |
| [vercel-deployment.md](./vercel-deployment.md) | Operators | Vercel app, env vars, CI secrets |
| [signer-deployment-options.md](./signer-deployment-options.md) | Operators | Remote signer hosts + Apache JWT DMZ |
| [turnkey-ticket-funding.md](./turnkey-ticket-funding.md) | Operators / security | Turnkey deposit → TicketBroker (architecture + decision trees) |
| [builder-api.md](./builder-api.md) | Integrators | Builder / Billing / OIDC API surface |
| [moonpay-onramp-demo.md](./moonpay-onramp-demo.md) | Operators | Fiat on-ramp demo (phase-1) |
| [openmeter-railway.md](./openmeter-railway.md) | Operators | OpenMeter / Konnect on Railway |
| [openmeter-entitlements-cutover.md](./openmeter-entitlements-cutover.md) | Operators | Entitlements migration notes |

Repository-root policy (not under `docs/`):

| Document | Topic |
| --- | --- |
| [SECURITY.md](../SECURITY.md) | Vulnerability reporting + supported versions |
| [Architecture Diagram.md](../Architecture%20Diagram.md) | System topology (referenced by OpenMeter docs) |

---

## Documentation gap review — legal, compliance, security

Review date: 2026-07-23. Scope: contents of `docs/` plus adjacent root
`SECURITY.md`. This is an **engineering documentation inventory**, not legal
advice. Counsel should own final Terms / Privacy / DPA language.

### What exists today

| Area | Coverage | Where |
| --- | --- | --- |
| Vulnerability disclosure | Minimal but present (advisories + contact) | `SECURITY.md` |
| Signer network hardening | Strong operator guidance (DMZ, JWT scopes, private-network warnings) | `signer-deployment-options.md` |
| Deposit webhook trust boundaries | Signature verify, address binding, idempotency, CLI auth | `turnkey-ticket-funding.md` |
| Secret handling in deploy | Env / GitHub secret tables; “do not commit” notes | `vercel-deployment.md`, `openmeter-railway.md` |
| App-developer privacy URL | Schema + OIDC consent UI can link a per-app policy | Code / Builder settings (not a platform policy doc) |
| Automated scanning mention | CodeQL / Snyk / secret scanning called out | `SECURITY.md` |

### Gaps (prioritized)

#### P0 — Security / money-movement

1. **No platform threat model** — No single doc maps trust boundaries across
   OIDC, remote-signer identity webhook, Turnkey deposit webhook, CLI DMZ, and
   OpenMeter/Konnect settlement. Pieces exist in deployment and funding docs;
   an attacker-oriented STRIDE (or equivalent) overview is missing.
2. **No webhook / JWT security standard** — Identity webhook vs deposit webhook
   auth, replay windows, key rotation, and failure modes are split across code
   and partial docs. Need one “Authentication & webhook security” page.
3. **Incident response runbook absent** — No documented severity levels, paging,
   signer pause / funding kill-switch, key rotation, or customer notification
   steps for compromise of Turnkey keys, OIDC signing keys, or signer keystore.
4. **Key & secret lifecycle** — Rotation for `NEXTAUTH_SECRET`, OIDC JWKS,
   Turnkey API keys, `AUTH_TOKEN_PEPPER`, and signer ETH account / Turnkey
   wallet bootstrap is operational folklore, not written procedure.
5. **SECURITY.md incomplete for money rails** — No explicit scope of in-scope
   assets (TicketBroker funds, CLI admin JWT, billing credits) or out-of-scope
   (third-party MoonPay / Turnkey / chain finality).

#### P1 — Compliance / regulatory posture

6. **No platform Privacy Policy or Terms of Service** in-repo or linked from
   `docs/` — End-user and builder ToS/Privacy appear to live outside this tree;
   engineers lack a canonical link and data-processing summary.
7. **No data inventory / retention policy** — Neon tables hold emails, OAuth
   identities, API keys hashes, usage, on-ramp sessions, funding events. No doc
   states retention TTLs, deletion on account close, or log redaction rules.
8. **Subprocessor / vendor list missing** — Vercel, Neon, Railway, Turnkey,
   MoonPay, OpenMeter/Konnect, OAuth IdPs, RPC providers are implied by deploy
   docs but not listed for DPA / GDPR Art. 28 style disclosure.
9. **Fiat on-ramp / KYC-AML boundary unclear** — MoonPay demo docs describe
   product flow; they do not state who is MSB/VASP, who performs KYC, or what
   PymtHouse asserts vs disclaims for sanctions / travel-rule obligations.
10. **No audit / access-control matrix** — Admin vs app-owner vs end-user
    capabilities for billing, CLI, and funding are implemented in code without
    a compliance-readable access control summary.

#### P2 — Legal / product documentation hygiene

11. **No `docs/` README historically** — Discovery relied on GitHub folder
    listing ([docs on `main`](https://github.com/pymthouse/pymthouse/tree/main/docs)).
12. **Signer “Security Notes” are checklist-thin** — Emoji bullets in
    `signer-deployment-options.md` do not reference DMZ JWT details above or
    `SECURITY.md`.
13. **No customer-facing security whitepaper** — Useful for enterprise builders
    evaluating OIDC + remote signer; currently only implementation docs.
14. **Cross-links to counsel-owned pages** — OIDC consent can show per-app
    `privacyPolicyUrl`; platform policy URLs are not standardized in env/docs.

### Design decisions (this review)

| Decision | Rationale | Trade-off |
| --- | --- | --- |
| Keep gap list in `docs/README.md` | Single entry point next to the docs the gaps refer to | README will need periodic refresh as docs land |
| Do not draft Privacy/ToS in engineering docs | Legal ownership; incorrect DIY policy text creates liability | Gap remains until counsel publishes and we link |
| Treat Turnkey funding DFD as partial threat-model input | Money-movement path is highest immediate risk | Still need identity-webhook and OIDC coverage |

### Implementation tasks

- [x] Expand [turnkey-ticket-funding.md](./turnkey-ticket-funding.md) with data-flow and decision diagrams (this PR).
- [x] Add this docs index + gap inventory.
- [ ] Author `docs/security-threat-model.md` covering OIDC, identity webhook, deposit webhook, signer DMZ, billing.
- [ ] Author `docs/auth-and-webhooks.md` (JWT profiles, JWKS rotation, Turnkey signature verify, replay windows).
- [ ] Author `docs/incident-response.md` (severity, pause funding, rotate keys, notify).
- [ ] Author `docs/secrets-and-key-rotation.md` aligned with Vercel/Railway/Turnkey runbooks.
- [ ] Extend `SECURITY.md` with in-scope assets, money-movement notes, and link to the threat model.
- [ ] Publish or link platform Privacy Policy + Terms; add URLs to this README and product footers.
- [ ] Draft data inventory + retention TTLs (engineering draft for counsel review).
- [ ] Publish subprocessor list (engineering draft for counsel review).
- [ ] Document MoonPay/Turnkey KYC-AML responsibility split in `moonpay-onramp-demo.md` (or successor).
- [ ] Document admin / owner / end-user access control matrix.
- [ ] Replace thin signer “Security Notes” with links to DMZ section + `SECURITY.md`.
