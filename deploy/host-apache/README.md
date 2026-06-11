# Host Apache TLS for signer-dmz

| Stack | Host port | OIDC issuer | Public hostname |
|-------|-----------|-------------|-----------------|
| Primary (local pymthouse.com) | 8080 | `https://pymthouse.com/api/v1/oidc` | loopback only |
| Public (external pymthouse.com) | 8091 | `https://pymthouse.com/api/v1/oidc` | `signer.pymthouse.com` |
| Staging | 8090 | staging Vercel issuer | `signer-staging.eliteencoder.net` |

## Public signer (`signer.pymthouse.com` → port 8091)

DNS: `signer.pymthouse.com` → this host. JWKS/OIDC from **pymthouse.com**.

```bash
cp docker/signer-dmz/config/app.env.example docker/signer-dmz/config/app.env
# edit app.env (ETH_RPC_URL, etc.)
./docker/signer-dmz/scripts/init-app-data.sh

docker compose -f docker-compose.yml -f docker/signer-dmz/docker-compose.app.yml \
  --env-file docker/signer-dmz/config/app.env -p pymthouse-signer-app up -d --build

sudo cp deploy/host-apache/signer.pymthouse.com-le-ssl.conf /etc/apache2/sites-available/
sudo apache2ctl configtest && sudo systemctl reload apache2
```

Verify: `curl -sf https://signer.pymthouse.com/healthz`

## Primary (loopback 8080)

Local PymtHouse on this host uses `SIGNER_INTERNAL_URL=http://127.0.0.1:8080` with pymthouse.com OIDC — see `docker/signer-dmz/config/production.env.example`.

```bash
docker compose up -d --force-recreate signer-dmz
```

## Staging (`signer-staging.eliteencoder.net`)

Port **8090** — see `docker/signer-dmz/docker-compose.staging.yml` and `config/staging.env.example`.

## Legacy (`signer.eliteencoder.net`)

Proxy to **8080** (primary loopback DMZ), not 8081.
