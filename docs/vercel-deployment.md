# Vercel Deployment Guide for Pymthouse

This guide walks you through deploying Pymthouse to Vercel. Since Vercel doesn't support Docker containers, the `go-livepeer` signer service must be deployed separately.

## Architecture Overview

- **Next.js App** → Deployed to Vercel (serverless)
- **go-livepeer Signer** → Deployed to Railway/Render/Fly.io (Docker container)
- **PostgreSQL Database** → Neon, Supabase, or Vercel Postgres

## Prerequisites

1. Vercel account ([vercel.com](https://vercel.com))
2. PostgreSQL database (Neon recommended for free tier)
3. Docker hosting service account (Railway, Render, or Fly.io)
4. GitHub/Google OAuth app credentials (for admin login)
5. Turnkey account (optional, for embedded wallets via Wallet Kit)

## Step 1: Deploy go-livepeer Signer (Docker Container)

The signer can be deployed using either the binary release (recommended) or Docker image. 

**Binary Release Benefits:**
- ✅ ~50MB vs 500MB+ Docker image
- ✅ Faster deployments (2-3x)
- ✅ Lower memory usage
- ✅ Works with more platforms

See [docs/signer-deployment-options.md](./signer-deployment-options.md) for detailed comparison.

### Option A: Railway with Nixpacks (Recommended - Easiest)

Railway automatically uses the included `nixpacks.toml` configuration:

1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your pymthouse repository
4. Railway detects `nixpacks.toml` automatically
5. Add these environment variables:
   ```
   SIGNER_NETWORK=arbitrum-one-mainnet
   # Do not set PORT=8081 for signer-dmz — Railway injects PORT for Apache (typically 8080).
   ETH_RPC_URL=https://arb1.arbitrum.io/rpc
   ```
   Optional: `SIGNER_ETH_ADDR=0x...` (leave empty otherwise)
6. Under "Settings" → "Volumes":
   - Click "New Volume"
   - Mount path: `/app/data`
   - Size: 1GB
7. Under "Settings" → "Networking":
   - Public networking is enabled by default
   - Note the assigned URL (e.g., `https://your-app.up.railway.app`)
8. Deploy automatically starts

**That's it!** Railway downloads the binary and runs it. No Dockerfile needed.

**Command override** (in Railway settings → Deploy):
```bash
/bin/sh -c 'echo "" > /data/.eth-password && /usr/local/bin/livepeer -remoteSigner -network=$SIGNER_NETWORK -httpAddr=0.0.0.0:$SIGNER_PORT -cliAddr=0.0.0.0:4935 -ethUrl=$ETH_RPC_URL -ethAcctAddr=$SIGNER_ETH_ADDR -ethPassword=/data/.eth-password -datadir=/data -v=99'
```

### Option B: Railway with Docker (Alternative)

If you prefer using Docker:

1. Follow steps 1-3 above
2. In "Settings" → "Deploy":
   - Dockerfile Path: `docker/signer-dmz/Dockerfile` (Apache + livepeer; same as `railway.json`)
3. Add environment variables and volume (same as Option A)
4. Deploy

### Option C: Render

Render uses the included `render.yaml` blueprint:

1. Go to [render.com](https://render.com)
2. Click "New" → "Blueprint"
3. Connect your GitHub repository
4. Render auto-detects `render.yaml`
5. Review the configuration (environment variables, disk)
6. Click "Apply" to create the service

The Dockerfile downloads the binary for faster builds.

### Option D: Fly.io

Create a `fly.toml` file (separate from this Next.js app):

```toml
app = "pymthouse-signer"

[build]
  image = "livepeer/go-livepeer:0.8.10"

[env]
  SIGNER_NETWORK = "arbitrum-one-mainnet"
  SIGNER_PORT = "8081"
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
  destination = "/data"
```

Deploy with: `fly deploy`

## Step 2: Set Up PostgreSQL Database

### Using Neon (Recommended)

1. Go to [neon.tech](https://neon.tech)
2. Create a new project
3. Copy the connection string (looks like: `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`)
4. Keep this for Vercel environment variables

### Alternative: Vercel Postgres

1. In your Vercel project dashboard
2. Go to "Storage" tab
3. Create a new Postgres database
4. Vercel will automatically inject `DATABASE_URL` environment variable

## Step 3: Deploy to Vercel

### One Vercel project (production + staging)

PymtHouse deploys production and staging to the **same** Vercel project (`pymthouse`):

| Tier | URL | Deploy trigger |
|------|-----|----------------|
| **Production** | `https://pymthouse.com` | `v*` tag push, manual [release.yml](../.github/workflows/release.yml) (bump + tag + deploy), or [deploy-production-vercel.yml](../.github/workflows/deploy-production-vercel.yml) when `VERCEL_PRODUCTION_AUTO_DEPLOY=true` |
| **Staging** | `https://staging.pymthouse.com` | push to `main`, manual dispatch on [deploy-staging-vercel.yml](../.github/workflows/deploy-staging-vercel.yml) when `VERCEL_PREVIEW_AUTO_DEPLOY=true` |

Feature-branch auto-previews are **not** enabled yet — the Ignored Build Step stays `exit 1` so CI owns all deploys.

Railway (signer, OpenMeter collector) uses the **PymtHouse** project with two environments:

| Railway environment | Vercel target | Stack |
|---------------------|---------------|--------|
| `preview` | **staging** (`staging.pymthouse.com`) | Full clearinghouse stack (kafka + collector + signer) — [deploy-railway-preview.yml](../.github/workflows/deploy-railway-preview.yml) on `main` when `RAILWAY_PREVIEW_AUTO_DEPLOY=true` |
| `production` | **production** (`pymthouse.com`) | Same stack — [deploy-railway-production.yml](../.github/workflows/deploy-railway-production.yml) on `v*` tag when `RAILWAY_PRODUCTION_AUTO_DEPLOY=true` |

Point each Vercel tier’s `OPENMETER_URL` and `SIGNER_INTERNAL_URL` at the matching Railway environment’s public domains.

**Dashboard setup for `pymthouse`:**

1. Connect the same GitHub repo (optional — used only if you want visibility in Vercel).
2. Set **Ignored Build Step** to `exit 1` so direct Git pushes do not auto-deploy (CI owns production + staging).
3. Configure env vars under **Production** and **Preview** scopes — see [.env.vercel.template](../.env.vercel.template).

**Secrets:** env vars live in the Vercel dashboard. Do not commit `.env.vercel.production` or `.env.vercel.preview` (generated by `vercel pull`). If either was ever committed, rotate affected secrets in Vercel and GitHub.

**CI `vercel build` and sensitive vars:** Vercel marks Preview/Production secrets as *sensitive* and does not export them via `vercel pull` for local or GitHub Actions builds ([Vercel docs](https://vercel.com/docs/environment-variables/sensitive-environment-variables)). Non-sensitive vars (`NEXTAUTH_URL`, signer URLs, etc.) appear in the pull; `NEXTAUTH_SECRET` and `AUTH_TOKEN_PEPPER` must also exist as GitHub environment secrets on `vercel / preview` and `vercel / production` so `validate:env` passes during CI. Runtime on deployed previews/production still resolves secrets from Vercel.

**GitHub secret required for CI deploy:** `VERCEL_TOKEN` (same token used for CLI deploys).

**Enable deploy workflows** (after `VERCEL_TOKEN` is configured):

| Variable | Workflow | GitHub Environment |
|----------|----------|-------------------|
| `VERCEL_PRODUCTION_AUTO_DEPLOY=true` | [deploy-production-vercel.yml](../.github/workflows/deploy-production-vercel.yml) on `v*` tag (or via [release.yml](../.github/workflows/release.yml)) | `vercel / production` |
| `VERCEL_PREVIEW_AUTO_DEPLOY=true` | [deploy-staging-vercel.yml](../.github/workflows/deploy-staging-vercel.yml) on `main` | `vercel / preview` (deploys staging alias) |
| `RAILWAY_PREVIEW_AUTO_DEPLOY=true` | [deploy-railway-preview.yml](../.github/workflows/deploy-railway-preview.yml) on `main` | `railway / preview` |
| `RAILWAY_PRODUCTION_AUTO_DEPLOY=true` | [deploy-railway-production.yml](../.github/workflows/deploy-railway-production.yml) on `v*` tag (or via [release.yml](../.github/workflows/release.yml)) | `railway / production` |

```bash
bash scripts/set-github-production-vercel-vars.sh
bash scripts/set-github-production-railway-vars.sh
bash scripts/set-github-preview-deploy-vars.sh
bash scripts/set-github-deploy-url-vars.sh
```

Canonical URLs for the Deployments sidebar (`VERCEL_PRODUCTION_URL`, `VERCEL_PREVIEW_URL`, `RAILWAY_*_SIGNER_URL`) are set by [set-github-deploy-url-vars.sh](../scripts/set-github-deploy-url-vars.sh).

**Avoid double deploys:** In the **pymthouse** Vercel project → Settings → Git → **Ignored Build Step**, set `exit 1` so native Git integration does not also build on push (CI owns all deploys).

**Production release** (bump version, tag, deploy):

```bash
# GitHub Actions → Release (bump + tag + deploy prod) → choose patch/minor/major
```

Or push a tag manually: `git tag v0.1.1 && git push origin v0.1.1`

**Manual staging deploy:**

```bash
# GitHub Actions → Deploy staging (Vercel) → Run workflow
# or locally:
bash scripts/deploy-staging-vercel.sh
```

### Via Vercel CLI (production project)

1. Install Vercel CLI:
   ```bash
   npm install -g vercel
   ```

2. Login to Vercel:
   ```bash
   vercel login
   ```

3. From the project root, run:
   ```bash
   vercel
   ```

4. Follow the prompts:
   - Link to existing project or create new
   - Configure settings (use defaults)

### Via Vercel Dashboard

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your Git repository (GitHub, GitLab, or Bitbucket)
3. Configure project:
   - **Framework Preset**: Next.js
   - **Root Directory**: `./`
   - **Build Command**: `npm run build` (auto-detected)
   - **Output Directory**: `.next` (auto-detected)

## Step 3b: Deploy OpenMeter on Railway (separate project)

Usage, allowances, and trial balances require OpenMeter. Deploy it in a **second** Railway project (not on the signer service).

1. Follow **[openmeter-railway.md](./openmeter-railway.md)** — upload `docker-compose.openmeter.railway.yml`, attach volumes, generate a public domain on the `openmeter` service.
2. Run `OPENMETER_URL=https://… npm run openmeter:railway:bootstrap` once the API is healthy.
3. Set `OPENMETER_URL` on Vercel (Step 4 below).

The remote signer does **not** need OpenMeter env vars; metering goes PymtHouse → OpenMeter over HTTPS.

## Step 4: Configure Vercel Environment Variables

In your Vercel project dashboard, go to "Settings" → "Environment Variables" and add:

### Required Variables

| Variable Name | Value | Example |
|--------------|-------|---------|
| `DATABASE_URL` | Your PostgreSQL connection string | `postgresql://user:pass@host/db` |
| `NEXTAUTH_URL` | Your production URL | `https://pymthouse.vercel.app` |
| `NEXTAUTH_SECRET` | Random secret (generate with `openssl rand -base64 32`) | `your-secret-here` |
| `SIGNER_INTERNAL_URL` | Your deployed signer URL from Step 1 | `https://your-signer.up.railway.app` |
| `SIGNER_CLI_URL` | Same as SIGNER_INTERNAL_URL (or separate if exposed) | `https://your-signer.up.railway.app` |
| `OPENMETER_URL` | Self-hosted OpenMeter on Railway (**separate project**) | `https://openmeter-xxxx.up.railway.app` |
| `OPENMETER_API_KEY` | Optional; set if OpenMeter auth is enabled | (secret) |
| `OPENMETER_TRIAL_FEATURE_KEY` | Trial entitlement feature | `network_spend` |
| `SIGNER_NETWORK` | Ethereum network | `arbitrum-one-mainnet` |
| `ETH_RPC_URL` | Ethereum RPC endpoint | `https://arb1.arbitrum.io/rpc` |

### OAuth Providers (for admin login)

| Variable Name | Value |
|--------------|-------|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GITHUB_CLIENT_ID` | From GitHub OAuth Apps |
| `GITHUB_CLIENT_SECRET` | From GitHub OAuth Apps |

### Optional Variables

| Variable Name | Value | Purpose |
|--------------|-------|---------|
| `NEXT_PUBLIC_ORGANIZATION_ID` | From Turnkey dashboard (Wallet Kit) | Embedded wallet auth (public) |
| `NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID` | From Turnkey dashboard (Auth Proxy) | Embedded wallet auth (public) |
| `TURNKEY_ALLOWED_ORGANIZATION_IDS` | Optional comma-separated org UUIDs | Restrict which orgs’ session JWTs are accepted |
| `OIDC_DEBUG_LOGS` | `1` to enable | Debug OIDC flows |

**Important**: Make sure to set these for all environments (Production, Preview, Development) or at minimum for Production.

## Step 5: Configure OAuth Callback URLs

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to your OAuth 2.0 Client
3. Add Authorized redirect URIs:
   ```
   https://your-domain.vercel.app/api/auth/callback/google
   ```

### GitHub OAuth

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click on your OAuth App
3. Set Authorization callback URL:
   ```
   https://your-domain.vercel.app/api/auth/callback/github
   ```

## Step 6: Deploy and Initialize Database

1. Push your code to Git (Vercel will auto-deploy) or run:
   ```bash
   vercel --prod
   ```

2. After deployment, run the bootstrap script to create admin user:
   ```bash
   # Install Vercel CLI if you haven't
   npm run bootstrap
   ```
   
   Or use Vercel's remote command execution:
   - Go to your project → "Deployments"
   - Click on the latest deployment
   - Use the deployment logs to verify database migrations ran

## Step 7: Verify Deployment

1. Visit your deployed URL: `https://your-domain.vercel.app`
2. Test admin login via Google/GitHub OAuth
3. Navigate to signer configuration and verify connection to your deployed go-livepeer service
4. Check remote signer DMZ health (see `GET /api/v1/health` signer probe)

## Troubleshooting

### Database Migration Issues

If migrations don't run automatically:

```bash
# Set DATABASE_URL locally
export DATABASE_URL="your-neon-or-vercel-postgres-url"

# Run migrations
npm run db:migrate
```

### Signer Connection Fails

- Verify `SIGNER_INTERNAL_URL` is publicly accessible
- Check that go-livepeer service is running (check Railway/Render logs)
- Ensure port 8081 is exposed and accessible
- Test the signer endpoint: `curl https://your-signer-url/status`

### Build Failures

- Check Vercel build logs for errors
- Verify all required environment variables are set
- Set `DATABASE_URL` on the Vercel project (Production scope). It must be present at **runtime**; the build does not run migrations (`prebuild` skips `db:prepare` when `VERCEL=1`). If CI `vercel build` warns that `DATABASE_URL` is missing at build time, add it in the dashboard or enable it for **Build** as well as **Production**.

### OAuth Redirect Issues

- Verify `NEXTAUTH_URL` matches your actual domain
- Check OAuth provider callback URLs match exactly
- Must use HTTPS in production (not HTTP)

## Custom Domain (Optional)

1. In Vercel dashboard → "Settings" → "Domains"
2. Add your custom domain
3. Configure DNS records as instructed
4. Update `NEXTAUTH_URL` to your custom domain
5. Update OAuth provider callback URLs

## Monitoring and Logs

- **Vercel Logs**: Dashboard → "Deployments" → Click on deployment → "View Function Logs"
- **Signer Logs**: Check Railway/Render/Fly.io dashboard logs
- **Database**: Use Neon dashboard or `npm run db:studio` (with DATABASE_URL set)

## Cost Optimization

- **Vercel**: Free tier includes 100GB bandwidth, 100GB-hours compute
- **Neon**: Free tier includes 3GB storage, autoscaling to zero
- **Railway**: $5/month credit, pay for usage
- **Render**: Free tier for web services (may spin down after inactivity)

## Security Checklist

- [ ] `NEXTAUTH_SECRET` is a strong random value
- [ ] OAuth secrets are kept secure (not in git)
- [ ] Database uses SSL (`sslmode=require` in connection string)
- [ ] Signer service uses HTTPS if exposed publicly
- [ ] Environment variables are set in Vercel (not in code)
- [ ] Admin user created with strong credentials

## Next Steps

- Set up CI/CD for automatic deployments
- Configure preview deployments for pull requests
- Set up monitoring (Vercel Analytics, Sentry)
- Enable OIDC custom domains for whitelabel apps
- Configure Turnkey Wallet Kit for embedded wallet authentication

## Support

For issues specific to:
- **Vercel deployment**: [Vercel docs](https://vercel.com/docs)
- **Database issues**: [Neon docs](https://neon.tech/docs) or [Vercel Postgres docs](https://vercel.com/docs/storage/vercel-postgres)
- **Docker hosting**: Railway/Render/Fly.io documentation
- **Pymthouse app**: Check repository issues or documentation
