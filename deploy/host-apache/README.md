# Host Apache (TLS) → Docker signer DMZ

On servers where **system Apache** terminates HTTPS (Let’s Encrypt) and Docker runs the **JWT DMZ** on loopback:

| Public hostname | Proxy target | Stack |
|-----------------|--------------|--------|
| `signer.eliteencoder.net` | `http://127.0.0.1:8080/` | Primary `signer-dmz` (prod issuer / port 8080) |
| `signer-staging.eliteencoder.net` | `http://127.0.0.1:8090/` | `pymthouse-signer-staging` (staging issuer) |

Do **not** proxy to `8081` — that is the bare go-livepeer HTTP port (no `mod_authnz_jwt`).

## Install

```bash
sudo cp deploy/host-apache/signer.eliteencoder.net.conf /etc/apache2/sites-available/
sudo cp deploy/host-apache/signer-staging.eliteencoder.net.conf /etc/apache2/sites-available/

# DNS A/AAAA for signer-staging.eliteencoder.net → this host first, then:
sudo certbot --apache -d signer-staging.eliteencoder.net

# Certbot’s generated *-le-ssl.conf does not include ProxyPass — copy ours after certbot:
sudo cp deploy/host-apache/signer-staging.eliteencoder.net-le-ssl.conf \
  /etc/apache2/sites-available/signer-staging.eliteencoder.net-le-ssl.conf
# Re-apply Let’s Encrypt paths if needed (templates use the standard live/ paths).

sudo a2ensite signer-staging.eliteencoder.net
sudo apache2ctl configtest && sudo systemctl reload apache2
```

For **signer.eliteencoder.net**, fix the existing `-le-ssl.conf` to proxy **8080** (not 8081), then reload.

## Vercel env

| Deployment | `SIGNER_INTERNAL_URL` | `SIGNER_CLI_URL` |
|------------|----------------------|------------------|
| Production | `https://signer.eliteencoder.net` | `https://signer.eliteencoder.net/__signer_cli` |
| Staging | `https://signer-staging.eliteencoder.net` | `https://signer-staging.eliteencoder.net/__signer_cli` |

Staging app: `NEXTAUTH_URL=https://pymthouse-staging.vercel.app`.
