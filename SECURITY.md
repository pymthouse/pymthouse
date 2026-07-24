# Security Policy

## Supported versions

Security fixes are applied to the current `main` branch and deployed production
environments ([pymthouse.com](https://pymthouse.com) and
[staging.pymthouse.com](https://staging.pymthouse.com)). Older release tags are
not supported unless called out in a security advisory.

## Reporting a vulnerability

**Do not** open a public GitHub issue for an undisclosed security problem.

Please report vulnerabilities privately using one of these channels:

1. **GitHub Security Advisories (preferred)** — use
   [Report a vulnerability](https://github.com/pymthouse/pymthouse/security/advisories/new)
   on this repository so maintainers can coordinate disclosure and fixes.
2. **Direct contact** — if you cannot use GitHub advisories, email the maintainers
   through your existing PymtHouse security contact channel.

Include:

- A clear description of the issue and impact
- Steps to reproduce (proof of concept if available)
- Affected components (e.g. OIDC, remote signer, billing API)
- Your preferred timeline for public disclosure

We aim to acknowledge reports within a few business days and will work with you
on remediation and credit where appropriate.

## Automated scanning

This repository runs security checks in CI, including CodeQL, Snyk, and secret
scanning. Findings may appear under the repository
[Security](https://github.com/pymthouse/pymthouse/security) tab when uploaded as
code scanning results.
