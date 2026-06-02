# Quick Deployment Checklist for Vercel

Use this checklist to deploy Pymthouse to Vercel in ~15 minutes.

## 🚀 Quick Steps

### 1. Deploy Docker Signer (5 min)

**Railway with Nixpacks (Easiest - Recommended)**
1. Go to [railway.app](https://railway.app) → New Project
2. Select "Deploy from GitHub repo" → Choose your repo
3. Railway auto-detects `nixpacks.toml` (downloads binary automatically)
4. Add environment variables:
   - `SIGNER_NETWORK`: `arbitrum-one-mainnet`
   - Do **not** set `PORT=8081` (that is go-livepeer loopback inside signer-dmz). Railway injects `PORT` for Apache; use `GET /healthz` on the public URL.
   - `ETH_RPC_URL`: `https://arb1.arbitrum.io/rpc`
5. Add volume: `/app/data` (1GB)
6. Railway auto-enables public networking
7. Copy the public URL (e.g., `https://app-name.up.railway.app`)

**Alternative: Railway with Docker**
- Same as above, but Railway uses `docker/signer-dmz/Dockerfile` (Apache JWT DMZ + livepeer in one image; see `railway.json`)

**OR Render (Blueprint)**
- Push code → Render detects `render.yaml` → Deploy

### 2. Setup Database (3 min)

**Neon (Free)**
1. Go to [neon.tech](https://neon.tech) → New Project
2. Copy connection string
3. Save for Vercel

**OR Vercel Postgres**
- Will set up in Vercel dashboard (Step 3)

### 3. Deploy to Vercel (5 min)

```bash
# Install Vercel CLI
npm install -g vercel

# Login
vercel login

# Deploy
vercel
```

OR use Vercel dashboard: [vercel.com/new](https://vercel.com/new)

### 4. Set Environment Variables (2 min)

In Vercel dashboard → Settings → Environment Variables:

**Required:**
```
DATABASE_URL=postgresql://...  (from Step 2)
NEXTAUTH_URL=https://your-app.vercel.app
NEXTAUTH_SECRET=<run: openssl rand -base64 32>
SIGNER_INTERNAL_URL=https://your-railway-app.up.railway.app  (from Step 1)
SIGNER_CLI_URL=https://your-railway-app.up.railway.app  (same as above)
ETH_RPC_URL=https://arb1.arbitrum.io/rpc
SIGNER_NETWORK=arbitrum-one-mainnet
```

**For OAuth (optional but recommended):**
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

### 5. Redeploy (1 min)

After adding env vars:
```bash
vercel --prod
```

OR trigger redeploy in Vercel dashboard

### 6. Test

1. Visit your app: `https://your-app.vercel.app`
2. Try logging in
3. Check signer status in dashboard

## 🔧 Troubleshooting

| Issue | Fix |
|-------|-----|
| "DATABASE_URL required" error | Add DATABASE_URL in Vercel env vars, redeploy |
| Can't connect to signer | Verify SIGNER_INTERNAL_URL is public and signer is running |
| OAuth fails | Update callback URLs in Google/GitHub to match NEXTAUTH_URL |
| Build fails | Check Vercel function logs, ensure all env vars set |

## 📚 Full Documentation

See [vercel-deployment.md](./vercel-deployment.md) for detailed instructions.

## ⚡ One-Command Deploy (Advanced)

If you have Railway + Vercel CLI configured:

```bash
# Deploy signer to Railway
railway up --dockerfile docker/signer-dmz/Dockerfile

# Get Railway URL
railway status --json

# Deploy to Vercel
vercel --prod

# Set env vars in Vercel dashboard, then redeploy
```

## 💰 Cost

- **Vercel**: Free tier (100GB bandwidth)
- **Railway**: ~$5-10/month (500MB RAM, always on)
- **Neon**: Free tier (3GB storage)

**Total**: ~$5-10/month
