#!/bin/sh
set -eu

export PORT="${PORT:-8080}"
# Dedicated Apache listener that proxies only to livepeer CLI (admin scope).
# In-container dedicated CLI vhost (optional second listener; local compose uses /__signer_cli on PORT only).
export CLI_PORT="${CLI_PORT:-8082}"
export SIGNER_PORT="${SIGNER_PORT:-8081}"
# Align Apache iss/aud with DMZ JWTs from this app (getIssuer). Pass NEXTAUTH_URL
# from the host .env (same as the Next app); when OIDC_ISSUER is unset, derive it.
export NEXTAUTH_URL="${NEXTAUTH_URL:-http://localhost:3001}"
if [ -z "${OIDC_ISSUER:-}" ]; then
  _na_base="${NEXTAUTH_URL%/}"
  export OIDC_ISSUER="${_na_base}/api/v1/oidc"
fi
export OIDC_AUDIENCE="${OIDC_AUDIENCE:-$OIDC_ISSUER}"
# JWKS must reach the app from inside the container (loopback → host.docker.internal).
if [ -z "${JWKS_URI:-}" ]; then
  export JWKS_URI="$(
    OIDC_ISSUER="$OIDC_ISSUER" python3 -c "
import os
from urllib.parse import urlparse, urlunparse
iss = os.environ['OIDC_ISSUER'].rstrip('/')
u = urlparse(iss + '/jwks')
h = (u.hostname or '').lower()
if h in ('localhost', '127.0.0.1'):
    netloc = 'host.docker.internal'
    if u.port:
        netloc += ':' + str(u.port)
    u = u._replace(netloc=netloc)
print(urlunparse(u))
"
  )"
fi
export JWT_PEM_PATH="${JWT_PEM_PATH:-/run/jwt/jwks.pem}"

if [ -n "${SIGNER_UPSTREAM:-}" ]; then
  export SIGNER_HTTP_ADDR="${SIGNER_UPSTREAM}"
  # Derive the CLI address from SIGNER_UPSTREAM when not explicitly set, preserving scheme+host.
  # The CLI listens on port 4935 by default in go-livepeer (-cliAddr=127.0.0.1:4935).
  if [ -z "${SIGNER_CLI_HTTP_ADDR:-}" ]; then
    # shellcheck disable=SC2016
    _scheme="$(printf '%s' "$SIGNER_UPSTREAM" | sed -n 's#^\(https\{0,1\}\)://.*$#\1#p')"
    _host="$(printf '%s' "$SIGNER_UPSTREAM" | sed -n 's#^https\{0,1\}://\([^:/]*\).*$#\1#p')"
    if [ -z "$_scheme" ] || [ -z "$_host" ]; then
      echo "entrypoint: SIGNER_UPSTREAM is not a valid http(s) URL: ${SIGNER_UPSTREAM}" >&2
      exit 1
    fi
    export SIGNER_CLI_HTTP_ADDR="${_scheme}://${_host}:4935"
  fi
else
  # No upstream configured → the HTTP signer must come from a local livepeer process
  # that this entrypoint spawns below. If the binary is missing we have nothing to
  # bind 127.0.0.1:${SIGNER_PORT}; failing here prevents Apache from coming up with
  # a catch-all ProxyPass pointing at a dead loopback port (which would otherwise
  # surface only as opaque 502s at request time).
  if [ ! -x /usr/local/bin/livepeer ]; then
    echo "entrypoint: SIGNER_UPSTREAM is unset and /usr/local/bin/livepeer is missing; refusing to start with an unreachable signer" >&2
    exit 1
  fi
  export SIGNER_HTTP_ADDR="http://127.0.0.1:${SIGNER_PORT}"
  # CLI lives in the same local livepeer process on port 4935. Respect an explicit
  # override (e.g. tests pointing at a fake) but default to loopback otherwise.
  export SIGNER_CLI_HTTP_ADDR="${SIGNER_CLI_HTTP_ADDR:-http://127.0.0.1:4935}"
fi

mkdir -p /run/jwt
if ! python3 /opt/pymthouse/scripts/jwks_to_pem.py --url "$JWKS_URI" --out "$JWT_PEM_PATH"; then
  echo "entrypoint: JWKS sync failed" >&2
  exit 1
fi

(
  while true; do
    sleep "${JWKS_REFRESH_SECONDS:-900}"
    if python3 /opt/pymthouse/scripts/jwks_to_pem.py --url "$JWKS_URI" --out "${JWT_PEM_PATH}.next" 2>/dev/null; then
      if ! cmp -s "$JWT_PEM_PATH" "${JWT_PEM_PATH}.next"; then
        mv "${JWT_PEM_PATH}.next" "$JWT_PEM_PATH"
        apache2ctl graceful 2>/dev/null || true
      else
        rm -f "${JWT_PEM_PATH}.next"
      fi
    fi
  done
) &

if [ -z "${SIGNER_UPSTREAM:-}" ] && [ -x /usr/local/bin/livepeer ]; then
  if [ ! -f /data/.eth-password ]; then
    echo "" >/data/.eth-password
  fi
  ARGS="-remoteSigner -network=${SIGNER_NETWORK:-arbitrum-one-mainnet} -httpAddr=127.0.0.1:${SIGNER_PORT} -cliAddr=127.0.0.1:4935 -ethUrl=${ETH_RPC_URL:-https://arb1.arbitrum.io/rpc} -ethPassword=/data/.eth-password -datadir=/data -v=99"
  if [ -n "${SIGNER_ETH_ADDR:-}" ]; then
    ARGS="$ARGS -ethAcctAddr=${SIGNER_ETH_ADDR}"
  fi
  if [ "${SIGNER_REMOTE_DISCOVERY:-0}" = "1" ] || [ "${SIGNER_REMOTE_DISCOVERY:-0}" = "true" ]; then
    ARGS="$ARGS -remoteDiscovery=true"
    [ -n "${ORCH_WEBHOOK_URL:-}" ] && ARGS="$ARGS -orchWebhookUrl=${ORCH_WEBHOOK_URL}"
    [ -n "${LIVE_AI_CAP_REPORT_INTERVAL:-}" ] && ARGS="$ARGS -liveAICapReportInterval=${LIVE_AI_CAP_REPORT_INTERVAL}"
  fi
  /usr/local/bin/livepeer $ARGS &
  LIVEPEER_PID=$!
  i=0
  ready_timeout="${SIGNER_READY_TIMEOUT_SECONDS:-300}"
  ready=0
  while [ "$i" -lt "$ready_timeout" ]; do
    if ! kill -0 "$LIVEPEER_PID" 2>/dev/null; then
      echo "entrypoint: livepeer (pid $LIVEPEER_PID) exited before becoming ready" >&2
      wait "$LIVEPEER_PID" 2>/dev/null || true
      exit 1
    fi
    if curl -sf -X POST "http://127.0.0.1:${SIGNER_PORT}/sign-orchestrator-info" \
      -H "Content-Type: application/json" \
      -d "{}" >/dev/null 2>&1; then
      ready=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "entrypoint: livepeer did not become ready on 127.0.0.1:${SIGNER_PORT} within ${ready_timeout}s" >&2
    if kill -0 "$LIVEPEER_PID" 2>/dev/null; then
      kill "$LIVEPEER_PID" 2>/dev/null || true
      wait "$LIVEPEER_PID" 2>/dev/null || true
    fi
    exit 1
  fi
fi

export APACHE_LOG_DIR="${APACHE_LOG_DIR:-/var/log/apache2}"
mkdir -p "$APACHE_LOG_DIR"
# mod_authnz_jwt only explains a denial at `info` level. Default to info while
# the DMZ integration stabilises; set APACHE_AUTH_JWT_LOG_LEVEL=warn in prod.
export APACHE_AUTH_JWT_LOG_LEVEL="${APACHE_AUTH_JWT_LOG_LEVEL:-info}"

# Dump the resolved DMZ auth context so 401s can be diagnosed by comparing this
# to the claims on a minted token. Emitted on stderr (visible via `docker logs`).
{
  _pem_kids="(missing)"
  if [ -r "$JWT_PEM_PATH" ]; then
    _pem_kids="$(grep -c 'BEGIN PUBLIC KEY' "$JWT_PEM_PATH" 2>/dev/null || echo 0)"
  fi
  printf 'signer-dmz: auth config:\n'
  printf '  OIDC_ISSUER=%s\n' "$OIDC_ISSUER"
  printf '  OIDC_AUDIENCE=%s\n' "$OIDC_AUDIENCE"
  printf '  JWKS_URI=%s\n' "$JWKS_URI"
  printf '  JWT_PEM_PATH=%s (public keys: %s)\n' "$JWT_PEM_PATH" "$_pem_kids"
  printf '  SIGNER_HTTP_ADDR=%s\n' "$SIGNER_HTTP_ADDR"
  printf '  SIGNER_CLI_HTTP_ADDR=%s\n' "$SIGNER_CLI_HTTP_ADDR"
  printf '  APACHE_AUTH_JWT_LOG_LEVEL=%s\n' "$APACHE_AUTH_JWT_LOG_LEVEL"
} >&2

envsubst '${PORT} ${CLI_PORT} ${SIGNER_HTTP_ADDR} ${SIGNER_CLI_HTTP_ADDR} ${OIDC_ISSUER} ${OIDC_AUDIENCE} ${JWT_PEM_PATH} ${APACHE_AUTH_JWT_LOG_LEVEL}' < /etc/apache2/templates/ports.conf.in >/etc/apache2/ports.conf
envsubst '${PORT} ${CLI_PORT} ${SIGNER_HTTP_ADDR} ${SIGNER_CLI_HTTP_ADDR} ${OIDC_ISSUER} ${OIDC_AUDIENCE} ${JWT_PEM_PATH} ${APACHE_AUTH_JWT_LOG_LEVEL}' < /etc/apache2/templates/signer-dmz.conf.in >/etc/apache2/sites-available/signer-dmz.conf

# Do not use a2ensite/a2dissite as non-root: they touch /var/lib/apache2/site/enabled_by_admin/
# (root-only). sites-enabled is chowned to APACHE_RUN_USER in the image — symlink directly.
rm -f /etc/apache2/sites-enabled/000-default.conf 2>/dev/null || true
ln -sf /etc/apache2/sites-available/signer-dmz.conf /etc/apache2/sites-enabled/signer-dmz.conf

exec apache2ctl -D FOREGROUND
