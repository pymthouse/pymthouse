# go-livepeer Signer Deployment Options

The go-livepeer signer can be deployed in several ways. Choose the option that best fits your needs.

## Binary vs Docker Image

### Binary Release (Recommended)

**Pros:**
- ✅ Smaller size (~50MB compressed vs 500MB+ Docker image)
- ✅ Faster deployments and startup
- ✅ Works with more platforms (Heroku buildpacks, Railway Nixpacks)
- ✅ Lower memory footprint
- ✅ Easier to debug (just a binary)

**Cons:**
- ⚠️ Platform-specific (linux-amd64, darwin-amd64, etc.)
- ⚠️ Manual updates required

**Use for:** Railway (Nixpacks), Render, Fly.io, Heroku, or any buildpack-based platform

### Docker Image

**Pros:**
- ✅ Official maintained image
- ✅ Platform-independent
- ✅ Easy updates (just change tag)
- ✅ Pre-configured environment

**Cons:**
- ⚠️ Larger size
- ⚠️ Slower deployments
- ⚠️ More memory usage

**Use for:** Docker Compose (local dev), Kubernetes, AWS ECS, or platforms requiring Docker images

## Deployment Methods

### Option 1: Railway (Nixpacks) - Easiest with Binary

Railway's Nixpacks automatically detects and uses `nixpacks.toml`:

1. **Create new project on Railway**
2. **Connect GitHub repository**
3. **Railway auto-detects `nixpacks.toml`**
4. **Add environment variables:**
   ```
   SIGNER_NETWORK=arbitrum-one-mainnet
   PORT=8081
   ETH_RPC_URL=https://arb1.arbitrum.io/rpc
   SIGNER_ETH_ADDR=<optional>
   ```
5. **Add a volume** at `/app/data` for persistent storage
6. **Deploy** - Railway will download the binary and run it

**Cost:** ~$5-10/month for 500MB RAM

### Option 2: Railway (Dockerfile)

If you prefer Docker on Railway:

1. **Create new project**
2. **Settings → Deploy → Dockerfile Path:** `docker/signer-dmz/Dockerfile` (final stage = `signer-dmz`: Apache + livepeer). Use `docker/signer-dmz/Dockerfile.signer` only if you want go-livepeer **without** Apache.
3. **Add environment variables** (same as above)
4. **Add volume** at `/data`
5. **Deploy**

### Option 2b: Railway (Docker) — Apache JWT DMZ (recommended for public signers)

Expose only Apache on the internet: **mod_authnz_jwt** validates PymtHouse OIDC access tokens (RS256) on **CLI paths only** (`/__signer_cli` and optional dedicated `CLI_PORT`) using a PEM derived from the public [JWKS](https://pymthouse.com/api/v1/oidc/jwks). **go-livepeer** listens on loopback inside the same container. Signing HTTP paths are proxied without an Apache JWT gate; end-user authorization is enforced by the remote-signer webhook via forwarded `Authorization: Bearer` user JWTs.

1. **Dockerfile path:** `docker/signer-dmz/Dockerfile`. Default build target is the combined image (`signer-dmz`).
2. **Environment variables** (in addition to signer settings such as `SIGNER_NETWORK`, `ETH_RPC_URL`, volume at `/data`):

   | Variable | Purpose |
   |----------|---------|
   | `PORT` | Apache listen port (Railway sets this automatically). |
   | `OIDC_ISSUER` | Defaults to `https://pymthouse.com/api/v1/oidc`. Must match token `iss`. |
   | `OIDC_AUDIENCE` | Defaults to the same as issuer; must match token `aud`. |
   | `JWKS_URI` | Defaults to `https://pymthouse.com/api/v1/oidc/jwks`. Used at startup and on refresh. |
   | `JWKS_REFRESH_SECONDS` | Background JWKS refresh interval (default `900`). Triggers `apachectl graceful` when the PEM changes. |
   | `JWKS_TLS_INSECURE` | **Deprecated / ignored.** HTTPS JWKS always verifies certificates. For local/dev self-signed JWKS use `http://localhost` or `http://host.docker.internal` in `JWKS_URI`. |
   | `SIGNER_UPSTREAM` | Optional. If set (e.g. `http://signer:8081` in compose-only gateway builds), the container does **not** run livepeer and only proxies to this URL. |
   | `SIGNER_CLI_HTTP_ADDR` | Upstream for the CLI port (default `http://127.0.0.1:4935`). In compose, set to `http://signer:4935`. Apache exposes the CLI under **`/__signer_cli/`** on the same public port as the HTTP API. |

3. **JWT gates (Apache):** Paths under `/__signer_cli/` (and the dedicated `CLI_PORT` listener when enabled) require a JWT whose **`scope`** claim is exactly **`admin`**. Signing HTTP paths (`/generate-live-payment`, `/sign-orchestrator-info`, etc.) are open at Apache; clients send end-user Bearer JWTs and go-livepeer verifies identity via `REMOTE_SIGNER_WEBHOOK_URL`. PymtHouse mints short-lived RS256 admin JWTs for CLI calls after it has already validated the admin session (see `issueSignerDmzToken` with `gate: "cli"`).

4. **Vercel / Next.js:** Point **`SIGNER_INTERNAL_URL`** at the DMZ public origin (e.g. `https://your-signer.railway.app`). For CLI reads (deposit, balances), set **`SIGNER_CLI_URL`** to the same host with the CLI prefix, e.g. `https://your-signer.railway.app/__signer_cli` (no trailing slash). Optional **`SIGNER_DMZ_FORWARD_JWT=false`** disables attaching service JWTs (only for debugging without Apache).

5. **Health checks:** Use **`GET /healthz`** on the public URL (returns `200` and body `OK` from Apache). Do not rely on **`GET /status`** for remote signer mode: the go-livepeer remote signer HTTP API may not implement `/status`; the DMZ still proxies `/status` without JWT for compatibility with deployments that do support it.
6. **Limitations:** `mod_authnz_jwt` uses a **single PEM file**, refreshed from JWKS. During key rotation with multiple active keys, often refresh or accept a short overlap risk.

**Local compose (two containers — signer + Apache gateway):**

```bash
docker compose -f docker/signer-dmz/docker-compose.yml up --build
```

Gateway is on [http://localhost:8080](http://localhost:8080); the signer is not published. Use `curl http://localhost:8080/healthz` and authenticated calls to proxied paths with a PymtHouse-issued bearer token.

### Option 3: Render (Docker)

Render uses the `render.yaml` blueprint:

1. **Import repository** on Render
2. **Render auto-detects `render.yaml`**
3. **Adjust environment variables** in dashboard
4. **Deploy**

Render downloads the binary inside the Dockerfile for faster builds.

**Cost:** $7/month for starter tier (or free tier with spindown)

### Option 4: Fly.io (Binary or Docker)

#### Using Binary (Recommended)

Create a `fly.toml`:

```toml
app = "pymthouse-signer"

[build]
  [build.args]
    LIVEPEER_COMMIT = "0a1919e0c58986375df158433445563a45a04df8"
    LIVEPEER_SHA256 = "0ba7b032a95bf1969b6983dfe065bc802105d982242e141840df422be1a6bade"

[env]
  SIGNER_NETWORK = "arbitrum-one-mainnet"
  ETH_RPC_URL = "https://arb1.arbitrum.io/rpc"

[[services]]
  internal_port = 8081
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

[mounts]
  source = "livepeer_data"
  destination = "/app/data"
```

Create a `Dockerfile.fly`:

```dockerfile
FROM debian:bookworm-slim

ARG LIVEPEER_COMMIT
ARG LIVEPEER_SHA256

RUN apt-get update && \
    apt-get install -y wget ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    wget -q "https://build.livepeer.live/go-livepeer/${LIVEPEER_COMMIT}/livepeer-linux-amd64.tar.gz" -O livepeer-linux-amd64.tar.gz && \
    echo "${LIVEPEER_SHA256}  livepeer-linux-amd64.tar.gz" | sha256sum -c - && \
    tar -xzf livepeer-linux-amd64.tar.gz && \
    mv livepeer-linux-amd64/livepeer /usr/local/bin/livepeer && \
    chmod +x /usr/local/bin/livepeer && \
    rm -rf livepeer-linux-amd64*

RUN mkdir -p /app/data && echo "" > /app/.eth-password

WORKDIR /app

CMD ["livepeer", "-remoteSigner", "-network", "${SIGNER_NETWORK}", "-httpAddr", "0.0.0.0:8081", "-cliAddr", "0.0.0.0:4935", "-ethUrl", "${ETH_RPC_URL}", "-ethPassword", "/app/.eth-password", "-datadir", "/app/data", "-v", "99"]
```

Deploy:
```bash
fly launch
fly deploy
```

**Cost:** ~$3-5/month for shared-cpu-1x

### Option 5: Google Cloud Run (Docker)

Cloud Run can run the Docker container:

```bash
# Build and push to GCR
gcloud builds submit --tag gcr.io/PROJECT_ID/pymthouse-signer

# Deploy
gcloud run deploy pymthouse-signer \
  --image gcr.io/PROJECT_ID/pymthouse-signer \
  --platform managed \
  --port 8081 \
  --set-env-vars SIGNER_NETWORK=arbitrum-one-mainnet,ETH_RPC_URL=https://arb1.arbitrum.io/rpc \
  --allow-unauthenticated
```

**Note:** Cloud Run is stateless by default. You'll need to add a volume for `/data` or use Cloud Storage.

### Option 6: DigitalOcean App Platform

1. **Create new app** from GitHub
2. **Detect Dockerfile:** Select `docker/signer-dmz/Dockerfile` (DMZ) or `docker/signer-dmz/Dockerfile.signer` (livepeer only)
3. **Add environment variables**
4. **Attach a managed database** or volume for `/data`
5. **Deploy**

**Cost:** $5/month for basic tier

### Option 7: AWS ECS/Fargate

For production-grade AWS deployment:

1. **Push to ECR (Apache JWT DMZ + livepeer in one image):**
   ```bash
   docker build -f docker/signer-dmz/Dockerfile -t pymthouse-signer-dmz .
   docker tag pymthouse-signer-dmz:latest AWS_ACCOUNT.dkr.ecr.REGION.amazonaws.com/pymthouse-signer-dmz:latest
   docker push AWS_ACCOUNT.dkr.ecr.REGION.amazonaws.com/pymthouse-signer-dmz:latest
   ```

   The DMZ container runs **Apache on `$PORT`** (set in the task definition, e.g. `8080`); go-livepeer listens on loopback inside the container. Map the load balancer to **`$PORT`**, not raw `8081`.

2. **Create ECS task definition** with:
   - Container image from ECR
   - Port mappings: container port = the **`PORT`** you set (Apache), not 8081 alone
   - Environment variables (`OIDC_ISSUER`, `JWKS_URI`, `SIGNER_NETWORK`, `ETH_RPC_URL`, etc.)
   - EFS volume for `/data`

3. **Create ECS service** with Application Load Balancer

**Cost:** ~$15-30/month for Fargate + ALB

#### Alternative: Signer-only (non-DMZ) — use with caution

> **Warning:** `docker/signer-dmz/Dockerfile.signer` is the **go-livepeer binary with no Apache JWT gate in front of it.** It has **none** of the DMZ protections (no RS256/JWKS verification, no `scope=admin` / `scope=sign:job` enforcement, no `Authorization` header stripping before upstream). Anything that can reach the container's listening port can call the signer's HTTP and CLI APIs directly.
>
> Only use this image when **all** of the following apply:
> - It is deployed on a **private network** (VPC-internal ALB/NLB, security group locked down to the Next.js app's egress, no public ingress).
> - **Another authenticated hop** (your Next.js server, a sidecar, or a separate Apache/ingress-level auth layer) sits between the public internet and the signer.
> - You understand that the signer container **exposes admin-equivalent endpoints** on port `4935` (`-cliAddr`) — sender info, keystore interactions, etc.
>
> For any **public-facing** deployment, use the DMZ build above (`docker/signer-dmz/Dockerfile`) instead.

1. **Build, tag, and push the signer-only image:**
   ```bash
   docker build -f docker/signer-dmz/Dockerfile.signer -t pymthouse-signer .
   docker tag pymthouse-signer:latest AWS_ACCOUNT.dkr.ecr.REGION.amazonaws.com/pymthouse-signer:latest
   docker push AWS_ACCOUNT.dkr.ecr.REGION.amazonaws.com/pymthouse-signer:latest
   ```

2. **Create ECS task definition** with port mappings `8081` (HTTP) and (if needed by another internal client) `4935` (CLI), plus an EFS volume for `/data`.

3. **Create an internal-only ECS service** (no public ALB) and point `SIGNER_INTERNAL_URL` / `SIGNER_CLI_URL` on the Next.js app at its private hostname.

## Binary Releases Available

From https://github.com/livepeer/go-livepeer/releases:

- `livepeer-linux-amd64.tar.gz` - Most common (Railway, Render, Fly.io)
- `livepeer-linux-arm64.tar.gz` - ARM servers
- `livepeer-darwin-amd64.tar.gz` - macOS Intel (local dev)
- `livepeer-darwin-arm64.tar.gz` - macOS Apple Silicon (local dev)
- `livepeer-windows-amd64.tar.gz` - Windows (local dev)

## Recommended: Railway with nixpacks.toml

**Why?**
- ✅ Simplest setup (just push code)
- ✅ Automatic binary download
- ✅ Built-in health checks
- ✅ Easy volume management
- ✅ Great developer experience
- ✅ Pay-as-you-go pricing

**Steps:**
1. Push code with `nixpacks.toml` to GitHub
2. Import to Railway
3. Add env vars
4. Add volume at `/app/data`
5. Deploy

Done in 5 minutes!

## Testing the Deployment

After deployment, test your signer:

```bash
# Health check (plain Docker / Nixpacks signer)
curl https://your-signer-url/status

# Apache DMZ image — use /healthz for load balancers; /status may 404 in remote signer mode
curl https://your-signer-url/healthz

# Should return JSON with orchestrator info
curl https://your-signer-url/registeredOrchestrators
```

## Connecting to Vercel

Once deployed, add to Vercel environment variables:

```
SIGNER_INTERNAL_URL=https://your-signer-url
SIGNER_CLI_URL=https://your-signer-url/__signer_cli
```

Then redeploy your Vercel app.

## Monitoring

All platforms provide logs:

- **Railway:** Dashboard → Deployments → View Logs
- **Render:** Dashboard → Logs
- **Fly.io:** `fly logs`
- **Cloud Run:** Cloud Console → Logs

Look for:
- `HTTP server listening` - Signer started successfully
- `Livepeer Node` version info
- No connection errors to `ETH_RPC_URL`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Binary not found | Ensure wget/tar worked in build phase |
| Permission denied | Add `chmod +x livepeer` after download |
| Port binding error | Use `0.0.0.0:${PORT}` not `localhost` |
| Data persistence lost | Add volume/disk mount at `/data` or `/app/data` |
| Can't reach from Vercel | Ensure public URL is exposed, test with curl |

## Performance Comparison

| Platform | Cold Start | Memory Usage | Cost/mo |
|----------|-----------|--------------|---------|
| Railway (Binary) | ~5s | ~200MB | $5-10 |
| Railway (Docker) | ~10s | ~250MB | $5-10 |
| Render (Free) | ~30s | ~250MB | $0 (spindown) |
| Render (Starter) | ~10s | ~250MB | $7 |
| Fly.io | ~8s | ~200MB | $3-5 |
| Cloud Run | ~15s | ~250MB | Pay per use |

## Security Notes

- 🔒 Never commit `.eth-password` or keystore files to git
- 🔒 Use environment variables for sensitive data
- 🔒 Consider using HTTPS for all signer communication
- 🔒 Restrict network access if possible (VPC, private networks)
- 🔒 Monitor logs for unusual activity

## Updating the Binary

To update to a new version:

1. **Pick a build** from [go-livepeer Actions](https://github.com/livepeer/go-livepeer/actions) (or a tagged release). CI uploads linux-amd64 artifacts to **Google Cloud** at `https://build.livepeer.live/go-livepeer/<full-git-sha>/livepeer-linux-amd64.tar.gz` (same archive as the workflow artifact zip).

2. **Update** `LIVEPEER_COMMIT`, `LIVEPEER_SHA256`, and the download URL in:
   - `docker/signer-dmz/Dockerfile.signer`
   - `docker/signer-dmz/Dockerfile` (livepeer download in the `signer-dmz` image stage)
   - `nixpacks.toml` (install phase)

3. **Redeploy** on your platform

4. **Test** the new version

## Next Steps

- ✅ Deploy signer to chosen platform
- ✅ Get public URL
- ✅ Add URL to Vercel environment variables
- ✅ Deploy Next.js app to Vercel
- ✅ Test end-to-end flow
