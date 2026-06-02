# Signer Docker assets

Everything needed to run the go-livepeer signer with an optional **Apache + mod_authnz_jwt** DMZ in front of it lives here.

| File / directory | Purpose |
|------------------|---------|
| `Dockerfile.signer` | Minimal Debian image that downloads go-livepeer (Railway/Render-style single-service signer). |
| `Dockerfile` | Multi-stage build: Apache gateway (`gateway` target) and combined Apache + livepeer (`signer-dmz` target). |
| `docker-compose.yml` | Local two-container stack: signer + gateway (JWT DMZ). |
| `apache/` | `envsubst` templates for Apache (`ports.conf`, `signer-dmz` vhost). |
| `entrypoint.sh` | JWKS → PEM sync, optional livepeer spawn, Apache foreground. |
| `scripts/jwks_to_pem.py` | Fetches OIDC JWKS and writes one RSA public key as PEM for `mod_authnz_jwt`. |

**Compose (from repo root):**

```bash
docker compose -f docker/signer-dmz/docker-compose.yml up --build
```

**Build the standalone signer image (from repo root):**

```bash
docker build -f docker/signer-dmz/Dockerfile.signer -t pymthouse-signer .
```

Platform config (`railway.json`, `render.yaml`) builds `docker/signer-dmz/Dockerfile` (final image: Apache JWT DMZ + livepeer). For **livepeer only** (no Apache), use `Dockerfile.signer` instead. See [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) and [docs/signer-deployment-options.md](../../docs/signer-deployment-options.md).

## Host publish (local compose)

Repo **`docker-compose.yml`** and **`docker/signer-dmz/docker-compose.yml`** map the Apache DMZ to the host using **`SIGNER_DMZ_HOST_PORT`** (default **8080**) and **`SIGNER_DMZ_BIND_HOST`** (default **`127.0.0.1`**). Apache inside the container already listens on all interfaces; only the Docker publish is loopback by default.

To accept connections from other hosts on the server (LAN, public IP, reverse proxy on another interface), set in `.env` or the shell before `docker compose up`:

```bash
SIGNER_DMZ_BIND_HOST=0.0.0.0
```

PymtHouse on the same machine can keep **`SIGNER_INTERNAL_URL=http://127.0.0.1:8080`**. Open the port in the host firewall and terminate TLS at the edge; signing still requires valid DMZ JWTs (`scope=sign:job` / `admin`).

## Second stack (staging issuer, port 8090)

Run a **second** DMZ on another host port with a **different OIDC issuer** (e.g. staging Vercel). Each stack needs its own datadir and compose project; point **that** PymtHouse deployment’s `SIGNER_INTERNAL_URL` at the matching port.

```bash
# From repo root — copy keystore from ./data into ./data-staging
./docker/signer-dmz/scripts/init-staging-data.sh

docker compose -f docker-compose.yml -f docker/signer-dmz/docker-compose.staging.yml \
  --env-file docker/signer-dmz/config/staging.env.example \
  -p pymthouse-signer-staging up -d --build
```

| Stack | Project | Port | Env file | Data dir |
|-------|---------|------|----------|----------|
| Default | (default) | 8080 | root `.env` | `./data` |
| Staging | `pymthouse-signer-staging` | 8090 | `config/staging.env.example` | `./data-staging` |

Staging Vercel must use `NEXTAUTH_URL=https://pymthouse-staging.vercel.app` so discovery and DMZ JWT `iss` match. Set `SIGNER_INTERNAL_URL=http://<host>:8090` and `SIGNER_CLI_URL=http://<host>:8090/__signer_cli` on staging only.

Copy `config/staging.env.example` → `config/staging.env` to override `ETH_RPC_URL` / `SIGNER_ETH_ADDR` locally.

## Railway networking (Docker DMZ)

The image listens on **`$PORT`** (Apache HTTP + `/__signer_cli`, `/healthz`, proxied signer API) and **`$CLI_PORT`** (default **8082**, dedicated CLI-only vhost). **go-livepeer** binds **127.0.0.1:8081** (HTTP) and **127.0.0.1:4935** (CLI) inside the container — they are **not** the ports Railway’s public hostname should target.

1. **Public domain → container port**  
   Point the primary Railway hostname at **Apache’s port**, i.e. whatever **`PORT`** is at runtime (Railway usually sets **`PORT=8080`**). Do **not** set the edge to **8081** or **4935**; that produces **502**s because nothing listens on all interfaces there.

2. **CLI from the internet**  
   You can use **one** public URL on **`PORT`** only: Apache already proxies **`/__signer_cli/`** on that same listener (see `apache/signer-dmz.conf.in`). Alternatively, expose **`CLI_PORT` (8082)** with a second hostname if you want the dedicated CLI vhost.

3. **`/__signer_cli` and PymtHouse — not automatic**  
   Apache serves **`https://<your-dmz-host>/__signer_cli`** on the **same** port as **`SIGNER_INTERNAL_URL`** (no extra path needed in `SIGNER_INTERNAL_URL`). The Next app **does not** infer that URL: **`getSignerCliUrl()`** uses **`SIGNER_CLI_URL`** if set, otherwise defaults to **`http://127.0.0.1:8080/__signer_cli`** (local compose’s single published port). For Railway single-port DMZ, set explicitly, for example:  
   `SIGNER_INTERNAL_URL=https://your-service.up.railway.app`  
   `SIGNER_CLI_URL=https://your-service.up.railway.app/__signer_cli`  
   (no trailing slash on `SIGNER_CLI_URL`.)

4. **Persistence**  
   Mount a volume at **`/data`** so the keystore and livepeer datadir survive redeploys.

5. **Health check**  
   Use **`GET /healthz`** (200, body `OK`) from the public URL.

The Dockerfile declares **`EXPOSE 8080 8082`** as documentation for platforms that infer default ports from the image.

## Troubleshooting DMZ `401` (HTML body from PymtHouse `/api/signer/*`)

PymtHouse validates your **OIDC** `Authorization: Bearer` token, then calls Apache with a **separate** short-lived RS256 JWT (`issueSignerDmzToken`, same `iss`/`aud` as `GET {issuer}/.well-known/openid-configuration`).

1. **Issuer string must match exactly** between Next (`getIssuer()` → `OIDC_ISSUER` or `NEXTAUTH_URL` + `/api/v1/oidc`) and the DMZ container (`OIDC_ISSUER` / `OIDC_AUDIENCE` in `entrypoint.sh`). A common break is `http://localhost:3001/...` in Docker vs `http://127.0.0.1:3001/...` in `.env.local` — pick one host form and use it everywhere.
2. **JWKS**: the DMZ container must fetch the same keys the app signs with (`JWKS_URI`; default rewrites `localhost` → `host.docker.internal` on Linux via `extra_hosts` in repo `docker-compose.yml`). Remote-only DMZ needs a **reachable** JWKS URL (tunnel, public URL, or VPN), not loopback on the PymtHouse laptop. If JWKS is **HTTPS** with a **self-signed** or corporate-intercepted certificate, set **`JWKS_TLS_INSECURE=1`** in the container environment (see `scripts/jwks_to_pem.py`). For `https://host.docker.internal/...`, TLS verification is skipped automatically without the flag.
3. **Where PymtHouse sends traffic**: `SIGNER_INTERNAL_URL` (or DB signer URL / port) must be the **Apache** listener (e.g. `http://127.0.0.1:8080`), not go-livepeer `:8081` inside the container.
4. From **python-gateway**, run `examples/debug_signer_chain.py --billing-url …` with your access token to print discovery `issuer` vs token claims and to POST `sign-orchestrator-info` in one step.
