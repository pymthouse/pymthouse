# # Created by Vercel CLI
# DATABASE_URL="postgresql://neondb_owner:npg_6hKxerAWbn3t@ep-gentle-bird-ae2cdznf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
# ETH_RPC_URL="http://nyc-router.eliteencoder.net:3517"
# NAAP_WEB_CLIENT_SECRET="rkt1i9J2sva7knmEPYIqhwf3F0k+9tH+aE9vPzKx3II="
# NEXTAUTH_SECRET="rkt1i9J2sva7knmEPYIqhwf3F0k+9tH+aE9vPzKx3II="
# NEXTAUTH_URL="https://pymthouse.vercel.app/"
# NEXT_PUBLIC_PRIVY_APP_ID="cmmray0jr02s40ckzgzu66qj2"
# PRIVY_APP_SECRET="privy_app_secret_5DprNxQyPx3X3nYVAoMReo1mkHSV7LmNzaK2Ekp6KVFFxre2SFAEsV97vsi23fpZCgSgdVBBGnpWPDFFp2nozkZt"
# SIGNER_CLI_URL="http://signer.eliteencoder.net:4935"
# SIGNER_INTERNAL_URL="https://signer.eliteencoder.net"
# SIGNER_NETWORK="arbitrum-one-mainnet"
# VERCEL_OIDC_TOKEN="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Im1yay00MzAyZWMxYjY3MGY0OGE5OGFkNjFkYWRlNGEyM2JlNyJ9.eyJpc3MiOiJodHRwczovL29pZGMudmVyY2VsLmNvbS9qb2hucy1wcm9qZWN0cy00MWNjNzA3NCIsInN1YiI6Im93bmVyOmpvaG5zLXByb2plY3RzLTQxY2M3MDc0OnByb2plY3Q6cHltdGhvdXNlOmVudmlyb25tZW50OmRldmVsb3BtZW50Iiwic2NvcGUiOiJvd25lcjpqb2hucy1wcm9qZWN0cy00MWNjNzA3NDpwcm9qZWN0OnB5bXRob3VzZTplbnZpcm9ubWVudDpkZXZlbG9wbWVudCIsImF1ZCI6Imh0dHBzOi8vdmVyY2VsLmNvbS9qb2hucy1wcm9qZWN0cy00MWNjNzA3NCIsIm93bmVyIjoiam9obnMtcHJvamVjdHMtNDFjYzcwNzQiLCJvd25lcl9pZCI6InRlYW1fSm9lTmhtSzdwZ2l1U2VPd2dRQVNBVUZsIiwicHJvamVjdCI6InB5bXRob3VzZSIsInByb2plY3RfaWQiOiJwcmpfb2xkdm5tZFhjR0RjN0RiNW9oUENPVUdCWk9hRyIsImVudmlyb25tZW50IjoiZGV2ZWxvcG1lbnQiLCJwbGFuIjoiaG9iYnkiLCJ1c2VyX2lkIjoiQmJHRXlLSE9rbWpyMDUzQW5EbUc4RVBsIiwiY2xpZW50X2lkIjoiY2xfSFl5T1BCTnRGTWZIaGFVbjlMNFFQZlRaejZUUDQ3YnAiLCJuYmYiOjE3NzYxODg1NDAsImlhdCI6MTc3NjE4ODU0MCwiZXhwIjoxNzc2MjMxNzQwfQ.jj_aOh0X0uUYdJ34q7og1A-0bgP3FesQ8mS2RuL985x0DVTggsyxiJAlTZ3hyOQ9q4icgCgmhmn29xb8kPlRdocHzm9USj8NokRYqAhWge9Cn_lDn310s039F04ktQXEPlVe4f0-0ZH6NmBuoe8VUpSFYVDgqR4420ebBbmp1MIB8BWPHUp90iKb6e1AfrMC81tpHZ85-LkFDWwvl4MonJ2WG3fxkCvj0xKExsLJrgJmLTJBxrwzPYFvQVE7rFrJFqBAGIRNa6AhtDktiZ2OvHpyrwLuD4BtqMx-BQV3rwO5_QT0T0jRc4_Fh4vVGFL-xLp6gNCYfy4jhpbHyNylRw"

# pymthouse environment configuration

# ---------- App ----------
NEXTAUTH_URL=https://staging.pymthouse.com
NEXTAUTH_SECRET=DKPNTN79JcFbfqk9nEVQjk8mcgijQyEwv08BnADyN5M=
AUTH_TOKEN_PEPPER=9l65hOW1gJ5fOApxF9H6b/Far5b9WXp50SBh8Bb+Qal/UrosetH0FoQYdXT/5Qv3

# ---------- OAuth Providers (admin login) ----------
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=Ov23liXCe2Vovzw2zs6H
GITHUB_CLIENT_SECRET=807be27e38846af7f9a5572ed106c8174c2c2a74

# ---------- Database ----------
# 
DATABASE_URL=postgresql://neondb_owner:npg_6hKxerAWbn3t@ep-misty-king-aecp1qeh-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require
# DATABASE_URL=postgresql://neondb_owner:npg_6hKxerAWbn3t@ep-gentle-bird-ae2cdznf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require

# ---------- go-livepeer Remote Signer (via Apache signer-dmz) ----------
# 127.0.0.1 (not "localhost"): docker-compose publishes signer-dmz on 127.0.0.1
# only, and on this host /etc/hosts + nss can resolve "localhost" to a LAN IP,
# causing ECONNREFUSED.
# SIGNER_INTERNAL_URL=http://127.0.0.1:8080
# SIGNER_CLI_URL=http://127.0.0.1:8080/__signer_cli

NAAP_API_BASE_URL=https://naap-api.cloudspe.com/v1

# not used on main branch yet
# DISCOVERY_SERVICE_URL=https://discovery-service-production-8955.up.railway.app
# DISCOVERY_SERVICE_BASE_URL=https://discovery-service-production-8955.up.railway.app


# Must match NEXTAUTH_URL host and NaaP PYMTHOUSE_ISSUER_URL (token exchange validates resource/iss).
# OIDC_ISSUER=http://localhost:3001/api/v1/oidc
# SIGNER_INTERNAL_URL=http://127.0.0.1:8080
# SIGNER_CLI_URL=http://127.0.0.1:8082
# SIGNER_DMZ_JWKS_URL=http://host.docker.internal:3001/api/v1/oidc/jwks

OIDC_ISSUER=https://staging.pymthouse.com/api/v1/oidc
SIGNER_INTERNAL_URL=https://pymthouse-preview.up.railway.app
SIGNER_CLI_URL=https://pymthouse-preview.up.railway.app

JWKS_TLS_INSECURE=1

SIGNER_NETWORK=arbitrum-one-mainnet
ETH_RPC_URL=http://nyc-router.eliteencoder.net:3517

NEXT_PUBLIC_ORGANIZATION_ID=4a6a9098-0f08-480f-b3a8-a8e1fbd5103e
NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID=c9bd2043-4849-4af0-8224-b31480d3ea51

TURNKEY_API_PUBLIC_KEY=0393ba83406d63b4e0cb2d2e30de9de1a2bf3f8d231dfdd2a2405098b266b33d5b
TURNKEY_API_PRIVATE_KEY=d26b68e3611231c84aefa27ad1de29ed369fd997fc19228ac7956f09a15f6d60
TURNKEY_API_BASE_URL=https://api.turnkey.com
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/KmXi-2UURShHpbEzy1Vbn


# PYMTHOUSE_PLATFORM_TREASURY_ADDRESS=
# TURNKEY_ALLOWED_ORGANIZATION_IDS=...
TURNKEY_ENABLE_SETTLEMENT_POLICIES=1
ETH_USD_PRICE=3000

LPNM_PAYER_DAEMON_SOCKET=/home/elite/repos/pymthouse/data/lpnm-run/payer-daemon.sock


# OPENMETER_URL=https://openmeter-production-5996.up.railway.app
# OPENMETER_API_KEY=<your-production-openmeter-api-key>


#OPENMETER_URL=http://127.0.0.1:48888
INGEST_SHARED_SECRET=CFxecjSQRIeHWW3DzEEmNH3O5ISF7LaZt3IR6WIyD8w=
OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS=5000000


BILLING_PLANS_API_V2=true
BILLING_STABLE_FEATURE_KEYS=true
SIGNER_PROXY_DB_WRITES=false
SIGNER_PROXY_API_INGEST=true


REMOTE_SIGNER_WEBHOOK_URL=http://host.docker.internal:3001/webhooks/remote-signer
# Shared secret for go-livepeer -remoteSignerWebhookHeaders (Authorization: Bearer ...).

WEBHOOK_SECRET=my-secret-webhook-secret
OPENMETER_URL=https://us.api.konghq.com/v3/openmeter
OPENMETER_API_KEY=kpat_emTf2UiUk2nOYO3CXing0QJQEXUifq9ZwVE0STRspRmAEyujZ
OPENMETER_ROUTE_MODE=hosted
# Kafka monitor event bus for go-livepeer create_signed_ticket events.
# KAFKA_BROKERS=kafka.railway.internal:9092
KAFKA_BROKERS=kafka:9092
KAFKA_GATEWAY_TOPIC=livepeer-gateway-events

#LPNM_TICKET_PARAMS_BASE_URL=
#LPNM_DISCOVERY_ORCH_URL=

# ---------- Privy (end-user wallets, Phase 4) ----------
# NEXT_PUBLIC_PRIVY_APP_ID=cmmray0jr02s40ckzgzu66qj2
# PRIVY_APP_SECRET=privy_app_secret_5DprNxQyPx3X3nYVAoMReo1mkHSV7LmNzaK2Ekp6KVFFxre2SFAEsV97vsi23fpZCgSgdVBBGnpWPDFFp2nozkZt

# VERCEL_OIDC_TOKEN="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Im1yay00MzAyZWMxYjY3MGY0OGE5OGFkNjFkYWRlNGEyM2JlNyJ9.eyJpc3MiOiJodHRwczovL29pZGMudmVyY2VsLmNvbS9qb2hucy1wcm9qZWN0cy00MWNjNzA3NCIsInN1YiI6Im93bmVyOmpvaG5zLXByb2plY3RzLTQxY2M3MDc0OnByb2plY3Q6cHltdGhvdXNlOmVudmlyb25tZW50OmRldmVsb3BtZW50Iiwic2NvcGUiOiJvd25lcjpqb2hucy1wcm9qZWN0cy00MWNjNzA3NDpwcm9qZWN0OnB5bXRob3VzZTplbnZpcm9ubWVudDpkZXZlbG9wbWVudCIsImF1ZCI6Imh0dHBzOi8vdmVyY2VsLmNvbS9qb2hucy1wcm9qZWN0cy00MWNjNzA3NCIsIm93bmVyIjoiam9obnMtcHJvamVjdHMtNDFjYzcwNzQiLCJvd25lcl9pZCI6InRlYW1fSm9lTmhtSzdwZ2l1U2VPd2dRQVNBVUZsIiwicHJvamVjdCI6InB5bXRob3VzZSIsInByb2plY3RfaWQiOiJwcmpfb2xkdm5tZFhjR0RjN0RiNW9oUENPVUdCWk9hRyIsImVudmlyb25tZW50IjoiZGV2ZWxvcG1lbnQiLCJwbGFuIjoiaG9iYnkiLCJ1c2VyX2lkIjoiQmJHRXlLSE9rbWpyMDUzQW5EbUc4RVBsIiwiY2xpZW50X2lkIjoiY2xfSFl5T1BCTnRGTWZIaGFVbjlMNFFQZlRaejZUUDQ3YnAiLCJuYmYiOjE3NzYxODg1NDAsImlhdCI6MTc3NjE4ODU0MCwiZXhwIjoxNzc2MjMxNzQwfQ.jj_aOh0X0uUYdJ34q7og1A-0bgP3FesQ8mS2RuL985x0DVTggsyxiJAlTZ3hyOQ9q4icgCgmhmn29xb8kPlRdocHzm9USj8NokRYqAhWge9Cn_lDn310s039F04ktQXEPlVe4f0-0ZH6NmBuoe8VUpSFYVDgqR4420ebBbmp1MIB8BWPHUp90iKb6e1AfrMC81tpHZ85-LkFDWwvl4MonJ2WG3fxkCvj0xKExsLJrgJmLTJBxrwzPYFvQVE7rFrJFqBAGIRNa6AhtDktiZ2OvHpyrwLuD4BtqMx-BQV3rwO5_QT0T0jRc4_Fh4vVGFL-xLp6gNCYfy4jhpbHyNylRw"

