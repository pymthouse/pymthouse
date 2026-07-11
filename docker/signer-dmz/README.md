# Signer Docker assets

Everything needed to run the go-livepeer signer with an optional **Apache + mod_authnz_jwt** DMZ in front of it lives here.

| File / directory | Purpose |
|------------------|---------|
| `Dockerfile.signer` | go-livepeer only, no Apache DMZ (legacy two-container stack; not for public deploy). |
| `Dockerfile` | Multi-stage: `gateway` (Apache only), `signer-dmz-local` (local dev), `signer-dmz` (production). |
| `docker-compose.yml` | Local two-container stack: signer + gateway (JWT DMZ). |
| `apache/` | `envsubst` templates for Apache (`ports.conf`, `signer-dmz` vhost). |
| `entrypoint.sh` | JWKS → PEM sync, optional livepeer spawn, Apache foreground. |
| `scripts/jwks_to_pem.py` | Fetches OIDC JWKS and writes one RSA public key as PEM for `mod_authnz_jwt`. |

## Build commands (from repo root)

| Image | Dockerfile | go-livepeer source | Use |
|-------|------------|--------------------|-----|
| `pymthouse/signer-dmz:local` | `Dockerfile` → `signer-dmz-local` | `../go-livepeer` via `lpclearinghouse` | **Local dev** with PymtHouse (`docker-compose.yml`) |
| `pymthouse/signer-dmz:latest` | `Dockerfile` → `signer-dmz` (default) | `livepeer/go-livepeer:sha-4214202f4458cda90bd030a0bbdddf7b3a1f52a5` | **Production** (Railway / Render) and prod smoke tests |
| `pymthouse-signer:local` | `Dockerfile.signer` | `livepeer/go-livepeer:sha-4214202f4458cda90bd030a0bbdddf7b3a1f52a5` | **Livepeer only** (no Apache; not for public deploy) |

### Force rebuild

Use `--pull --no-cache` when bumping the pinned `livepeer/go-livepeer` tag or Docker is serving a stale cached layer:

```bash
# Production DMZ (Apache + livepeer)
docker build --pull --no-cache -f docker/signer-dmz/Dockerfile -t pymthouse/signer-dmz:latest .

# Livepeer only (no Apache)
docker build --pull --no-cache -f docker/signer-dmz/Dockerfile.signer -t pymthouse-signer:local .

# Verify version after rebuild
docker run --rm --entrypoint /usr/local/bin/livepeer pymthouse-signer:local -version
docker run --rm --entrypoint /usr/local/bin/livepeer pymthouse/signer-dmz:latest -version
# expect: Livepeer Node Version: 0.8.10-e1e784f0
```

### Local dev

Builds go-livepeer from your `../go-livepeer` checkout, layers it into the Apache DMZ image, then starts the stack:

```bash
./scripts/build-local-signer.sh          # → pymthouse/signer-dmz:local
docker compose up -d signer-dmz
curl -sf http://127.0.0.1:8080/healthz  # expect: OK
```

`build-local-signer.sh` sets `SIGNER_DMZ_IMAGE` (default `pymthouse/signer-dmz:local`). Override with `SIGNER_DMZ_IMAGE=…` if needed.

Requires the Next app running so JWKS sync works (`NEXTAUTH_URL` in `docker-compose.yml`, default `http://localhost:3001`).

### Production build (smoke test)

Same Dockerfile Railway uses (`railway.json`, `render.yaml`). Default final stage is `signer-dmz`:

```bash
docker build -f docker/signer-dmz/Dockerfile -t pymthouse/signer-dmz:latest .

docker rm -f signer-dmz-smoke 2>/dev/null
docker run -d --name signer-dmz-smoke \
  -p 127.0.0.1:8080:8080 \
  -e PORT=8080 \
  -e NEXTAUTH_URL=http://localhost:3001 \
  -v "$(pwd)/data/signer-dmz:/data" \
  --add-host=host.docker.internal:host-gateway \
  pymthouse/signer-dmz:latest

curl -sf http://127.0.0.1:8080/healthz   # expect: OK (Next app must be up for JWKS)
docker exec signer-dmz-smoke /usr/local/bin/livepeer -version
```

On Railway, the image is built from the same Dockerfile; no local tag is required.

## Dedicated CLI port (8082)

Local compose publishes **`CLI_PORT`** (default **8082**) so `livepeer_cli -http 8082` uses the same paths as a bare node (`/ethAddr`, `/contractAddresses`, …) without the `/__signer_cli` prefix.

Set **`SIGNER_CLI_URL=http://127.0.0.1:8082`** in PymtHouse, or keep **`http://127.0.0.1:8080/__signer_cli`** on the main port.

On Railway, set **`SIGNER_DMZ_ENABLE_CLI_LISTENER=0`** for single-port hosts; CLI stays at **`/__signer_cli`** on **`$PORT`**.

## Turnkey Ephemeral Keystore Mode

The `signer-dmz` image can bootstrap an ephemeral `/data/keystore` from Turnkey at boot using `/usr/local/bin/signer-turnkey-bootstrap`.

- Activation is automatic: if all of `TURNKEY_ORG_ID`, `TURNKEY_API_PUBLIC_KEY`, and `TURNKEY_API_PRIVATE_KEY` are set, bootstrap runs.
- If any of those are unset, startup falls back to existing path-based keystore behavior.
- Bootstrap failures are fatal (bad creds, missing wallet/account, export/decrypt errors): container exits with logs.
- After livepeer becomes ready, `/data/keystore/*` and `/data/.eth-password` are deleted.

### Turnkey env vars

| Variable | Required | Notes |
|---|---|---|
| `TURNKEY_ORG_ID` | yes (for Turnkey mode) | Turnkey organization ID |
| `TURNKEY_API_PUBLIC_KEY` | yes (secret) | API public key (`02...`) |
| `TURNKEY_API_PRIVATE_KEY` | yes (secret) | API private key |
| `SIGNER_ETH_KEYSTORE_PASSWORD` | yes (secret) | Written to `/data/.eth-password` before livepeer starts |
| `TURNKEY_WALLET_NAME` | no | Default `livepeer-remote-signer` |
| `TURNKEY_API_HOST` | no | Default `api.turnkey.com` |
| `SIGNER_ETH_ADDR` | no | Optional pin; otherwise first ETH account is used/created |

### Local turnkey flow

1. Create env file from template:

```bash
cp docker/signer-dmz/config/turnkey.env.example docker/signer-dmz/config/turnkey.env
```

2. Fill `TURNKEY_*` and `SIGNER_ETH_KEYSTORE_PASSWORD` values in `docker/signer-dmz/config/turnkey.env`.

3. Build and run:

```bash
docker build --pull --no-cache -f docker/signer-dmz/Dockerfile -t pymthouse/signer-dmz:latest .
docker rm -f signer-dmz-turnkey-test 2>/dev/null
docker run -d --name signer-dmz-turnkey-test \
  --env-file docker/signer-dmz/config/turnkey.env \
  -e PORT=8080 -e NEXTAUTH_URL=http://localhost:3001 \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:8082:8082 \
  -v "$(pwd)/data/signer-turnkey:/data" \
  --add-host=host.docker.internal:host-gateway \
  pymthouse/signer-dmz:latest
```

4. Verify:

```bash
docker logs signer-dmz-turnkey-test 2>&1 | grep -E 'turnkey|keystore|bootstrap'
curl -sf http://127.0.0.1:8080/healthz
docker exec signer-dmz-turnkey-test ls /data/keystore  # expect empty after ready
```

### Legacy: two-container stack (gateway + signer)

Apache DMZ and go-livepeer run as separate containers (`gateway` target + `Dockerfile.signer`):

```bash
docker compose -f docker/signer-dmz/docker-compose.yml up --build
```

### Not for production: livepeer only (no Apache JWT gate)

`Dockerfile.signer` is a minimal go-livepeer image **without** the DMZ. Do not expose it publicly.

```bash
docker build --pull --no-cache -f docker/signer-dmz/Dockerfile.signer -t pymthouse-signer:local .
docker run --rm --entrypoint /usr/local/bin/livepeer pymthouse-signer:local -version
```

See [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) and [docs/signer-deployment-options.md](../../docs/signer-deployment-options.md).

## Host publish (local compose)

Repo **`docker-compose.yml`** and **`docker/signer-dmz/docker-compose.yml`** map the Apache DMZ to the host using **`SIGNER_DMZ_HOST_PORT`** (default **8080**) and **`SIGNER_DMZ_BIND_HOST`** (default **`127.0.0.1`**). Apache inside the container already listens on all interfaces; only the Docker publish is loopback by default.

To accept connections from other hosts on the server (LAN, public IP, reverse proxy on another interface), set in `.env` or the shell before `docker compose up`:

```bash
SIGNER_DMZ_BIND_HOST=0.0.0.0
```

PymtHouse on the same machine can keep **`SIGNER_INTERNAL_URL=http://127.0.0.1:8080`**. Open the port in the host firewall and terminate TLS at the edge; signing authorization is enforced by the remote-signer webhook (Bearer user JWT), while CLI paths still require Apache DMZ JWTs (`scope=admin`).

## Railway networking (Docker DMZ)

The image listens on **`$PORT`** (Apache HTTP + `/__signer_cli`, `/healthz`, proxied signer API) and **`$CLI_PORT`** (default **8082**, dedicated CLI-only vhost). **go-livepeer** binds **127.0.0.1:8081** (HTTP) and **127.0.0.1:4935** (CLI) inside the container — they are **not** the ports Railway’s public hostname should target.

1. **Public domain → container port**  
   Point the primary Railway hostname at **Apache’s port**, i.e. whatever **`PORT`** is at runtime (Railway usually sets **`PORT=8080`**). Do **not** set the edge to **8081** or **4935**; that produces **502**s because nothing listens on all interfaces there.

2. **CLI from the internet**  
   **Local / livepeer-cli:** publish **`CLI_PORT` (8082)** — Apache proxies livepeer-cli routes at **`/`** (`/contractAddresses`, `/ethAddr`, …) with no `/__signer_cli` prefix. Run `livepeer_cli -http 8082`.  
   **Single-port (Railway):** use **`/__signer_cli/`** on **`PORT`** (see `apache/signer-dmz.conf.in`), or expose **`CLI_PORT`** on a second hostname.

3. **`/__signer_cli` and PymtHouse — not automatic**  
   Apache serves **`https://<your-dmz-host>/__signer_cli`** on the **same** port as **`SIGNER_INTERNAL_URL`** (no extra path needed in `SIGNER_INTERNAL_URL`). The Next app **does not** infer that URL: **`getSignerCliUrl()`** uses **`SIGNER_CLI_URL`** if set, otherwise defaults to **`http://127.0.0.1:8080/__signer_cli`** (local compose’s single published port). For Railway single-port DMZ, set explicitly, for example:  
   `SIGNER_INTERNAL_URL=https://your-service.up.railway.app`  
   `SIGNER_CLI_URL=https://your-service.up.railway.app/__signer_cli`  
   (no trailing slash on `SIGNER_CLI_URL`.)

4. **Persistence**  
   Mount a volume at **`/data`** so the keystore and livepeer datadir survive redeploys.

5. **Health check**  
   Use **`GET /healthz`** (200, body `OK`) from the public URL.

The image **`EXPOSE`s `8080`** (signing) and **`8082`** (CLI). Set **`SIGNER_DMZ_ENABLE_CLI_LISTENER=0`** to disable the CLI listener (Railway single-port only). Railway health checks use **`GET /healthz`** on **`$PORT`** (see root `railway.json`).

## Troubleshooting DMZ auth

**CLI paths (`/__signer_cli`, dedicated `CLI_PORT`):** Apache returns HTML `401` when the admin DMZ JWT is missing or invalid. PymtHouse mints a short-lived RS256 JWT (`issueSignerDmzToken` with `gate: "cli"`, same `iss`/`aud` as `GET {issuer}/.well-known/openid-configuration`).

**Signing paths:** Apache does not gate signing HTTP; go-livepeer calls the remote-signer webhook with the client's `Authorization: Bearer` user JWT. Rejections surface as non-Apache JSON errors from go-livepeer or the webhook, not HTML `401` from mod_authnz_jwt.

1. **Issuer string must match exactly** between Next (`getIssuer()` → `OIDC_ISSUER` or `NEXTAUTH_URL` + `/api/v1/oidc`) and the DMZ container (`OIDC_ISSUER` / `OIDC_AUDIENCE` in `entrypoint.sh`) for **CLI** JWT verification. A common break is `http://localhost:3001/...` in Docker vs `http://127.0.0.1:3001/...` in `.env.local` — pick one host form and use it everywhere.
2. **JWKS** (CLI auth): the DMZ container must fetch the same keys the app signs with (`JWKS_URI`; default rewrites `localhost` → `host.docker.internal` on Linux via `extra_hosts` in repo `docker-compose.yml`). Remote-only DMZ needs a **reachable** JWKS URL (tunnel, public URL, or VPN), not loopback on the PymtHouse laptop. If JWKS is **HTTPS** with a **self-signed** or corporate-intercepted certificate, set **`JWKS_TLS_INSECURE=1`** in the container environment (see `scripts/jwks_to_pem.py`). For `https://host.docker.internal/...`, TLS verification is skipped automatically without the flag.
3. **Where PymtHouse sends traffic**: `SIGNER_INTERNAL_URL` (or DB signer URL / port) must be the **Apache** listener (e.g. `http://127.0.0.1:8080`), not go-livepeer `:8081` inside the container.
4. **Signing webhook**: ensure `REMOTE_SIGNER_WEBHOOK_URL` and `WEBHOOK_SECRET` are set on the signer container so go-livepeer can verify end-user Bearer JWTs.
5. From **python-gateway**, run `examples/debug_signer_chain.py --billing-url …` with your access token to print discovery `issuer` vs token claims and to POST `sign-orchestrator-info` in one step.
