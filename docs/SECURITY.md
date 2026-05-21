# Security

Security-critical areas in this repository:

- OIDC signing keys and token validation
- client secret storage and comparison
- device flow and token-exchange flows
- signer DMZ JWT issuance and Apache gate expectations
- app domain validation and redirect safety
- billing and usage attribution integrity

Current positive signals:

- CodeQL and Snyk are enabled in CI.
- The signer DMZ model removes public direct access to the signer when deployed correctly.
- OIDC code contains explicit handling for issuer/origin validation and redirect safety.

Current gaps:

- security invariants are not summarized in one repository-local source of truth
- architectural boundaries are not enforced mechanically, making accidental bypasses easier
- there is no dedicated linting for forbidden imports into security-sensitive modules

Required behavior for future changes:

- update docs when changing auth, token, signer, or billing trust boundaries
- keep security-sensitive parsing at boundaries
- avoid adding alternate auth paths without documenting the trust model
