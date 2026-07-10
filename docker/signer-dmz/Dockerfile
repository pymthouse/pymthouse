# syntax=docker/dockerfile:1
# Apache + mod_authnz_jwt in front of go-livepeer (DMZ). Targets:
#   gateway         — Apache only; set SIGNER_UPSTREAM (e.g. http://signer:8081) for docker compose.
#   signer-dmz-local — local dev; livepeer copied from LIVEPEER_IMAGE (see scripts/build-local-signer.sh).
#   signer-dmz      — production; livepeer from livepeer/go-livepeer Docker image (Railway single service).

# Base image for signer-dmz-local (override: docker build --build-arg LIVEPEER_IMAGE=...).
ARG LIVEPEER_IMAGE=livepeer/go-livepeer:sha-c884fa6617bbd67345af81ab4be8921edd59f19e

FROM debian:bookworm-slim AS build-mod

# Pin to commit SHAs (not mutable tags) so rebuilds are reproducible and safe from tag-rewrite.
# These correspond to:
#   libjwt         v1.12.1  (https://github.com/benmcollins/libjwt)
#   mod_authnz_jwt v1.2.0   (https://github.com/AnthonyDeroche/mod_authnz_jwt)
ARG LIBJWT_COMMIT=1ea509e8eab34819a490ceac595df6ea365079a3
ARG MOD_AUTHNZ_JWT_COMMIT=ba43b3f0c7a98603eb83ccbe83a37f0d33bc0700

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    make \
    automake \
    git \
    g++ \
    libtool \
    pkg-config \
    autoconf \
    libssl-dev \
    check \
    libjansson-dev \
    libz-dev \
    apache2 \
    apache2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN git clone https://github.com/benmcollins/libjwt.git && \
    cd libjwt && \
    git -c advice.detachedHead=false checkout "${LIBJWT_COMMIT}" && \
    git rev-parse --verify "${LIBJWT_COMMIT}^{commit}" >/dev/null && \
    autoreconf -i && \
    ./configure && \
    make && \
    make install && \
    ldconfig

RUN git clone https://github.com/AnthonyDeroche/mod_authnz_jwt.git && \
    cd mod_authnz_jwt && \
    git -c advice.detachedHead=false checkout "${MOD_AUTHNZ_JWT_COMMIT}" && \
    git rev-parse --verify "${MOD_AUTHNZ_JWT_COMMIT}^{commit}" >/dev/null && \
    autoreconf -ivf && \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure && \
    make && \
    make install

FROM golang:1.25.12-bookworm AS turnkey-bootstrap-build

WORKDIR /src
COPY docker/signer-dmz/turnkey-bootstrap/go.mod ./go.mod
COPY docker/signer-dmz/turnkey-bootstrap/go.sum ./go.sum
RUN go mod download
COPY docker/signer-dmz/turnkey-bootstrap/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/signer-turnkey-bootstrap .

FROM debian:bookworm-slim AS gateway

# Non-root runtime identity. Fixed UID/GID so bind-mounts and volumes are predictable.
ARG APP_USER=pymthouse
ARG APP_UID=10001
ARG APP_GID=10001

RUN apt-get update && apt-get install -y --no-install-recommends \
    apache2 \
    ca-certificates \
    curl \
    gettext-base \
    libcap2-bin \
    python3 \
    python3-cryptography \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build-mod /usr/local/lib/libjwt.so* /usr/local/lib/
COPY --from=build-mod /usr/lib/apache2/modules/mod_authnz_jwt.so /usr/lib/apache2/modules/mod_authnz_jwt.so
COPY --from=turnkey-bootstrap-build /out/signer-turnkey-bootstrap /usr/local/bin/signer-turnkey-bootstrap

RUN ldconfig && \
    printf '%s\n' 'LoadModule auth_jwt_module /usr/lib/apache2/modules/mod_authnz_jwt.so' \
      >/etc/apache2/mods-available/authnz_jwt.load && \
    a2enmod authnz_jwt && \
    a2enmod alias proxy proxy_http headers rewrite authn_core authz_core

COPY docker/signer-dmz/scripts/jwks_to_pem.py /opt/pymthouse/scripts/jwks_to_pem.py
COPY docker/signer-dmz/scripts/cleanup-ephemeral-keystore.sh /opt/pymthouse/scripts/cleanup-ephemeral-keystore.sh
COPY docker/signer-dmz/apache/ports.conf.in /etc/apache2/templates/ports.conf.in
COPY docker/signer-dmz/apache/signer-dmz.conf.in /etc/apache2/templates/signer-dmz.conf.in
COPY docker/signer-dmz/apache/signer-dmz-cli-vhost.conf.in /etc/apache2/templates/signer-dmz-cli-vhost.conf.in
COPY docker/signer-dmz/entrypoint.sh /entrypoint.sh

# Create an unprivileged user, pre-create all runtime-writable paths, and hand them off.
# Apache on Debian reads /etc/apache2/envvars for APACHE_RUN_USER/GROUP; override to the app user
# so the (non-root) master does not try to setuid.
RUN chmod +x /entrypoint.sh \
    /usr/local/bin/signer-turnkey-bootstrap \
    /opt/pymthouse/scripts/jwks_to_pem.py \
    /opt/pymthouse/scripts/cleanup-ephemeral-keystore.sh && \
    mkdir -p /var/www/static && printf "OK\n" > /var/www/static/healthz && \
    groupadd --system --gid "${APP_GID}" "${APP_USER}" && \
    useradd --system --uid "${APP_UID}" --gid "${APP_GID}" \
      --home-dir /home/${APP_USER} --create-home --shell /usr/sbin/nologin "${APP_USER}" && \
    mkdir -p /run/jwt /run/signer-bootstrap /run/apache2 /var/lock/apache2 /var/log/apache2 /data && \
    sed -i \
      -e "s|^export APACHE_RUN_USER=.*|export APACHE_RUN_USER=${APP_USER}|" \
      -e "s|^export APACHE_RUN_GROUP=.*|export APACHE_RUN_GROUP=${APP_USER}|" \
      /etc/apache2/envvars && \
    chown -R "${APP_USER}:${APP_USER}" \
      /etc/apache2/ports.conf \
      /etc/apache2/sites-available \
      /etc/apache2/sites-enabled \
      /var/log/apache2 \
      /var/lock/apache2 \
      /run/apache2 \
      /run/jwt \
      /run/signer-bootstrap \
      /var/www/static \
      /opt/pymthouse \
      /data && \
    # Allow the unprivileged user to bind to privileged ports (e.g. PORT=80 in compose)
    # without giving the whole container root. Safe because the cap is file-scoped.
    setcap cap_net_bind_service=+ep /usr/sbin/apache2

USER ${APP_USER}

ENTRYPOINT ["/entrypoint.sh"]

# Local dev: livepeer from LIVEPEER_IMAGE (see ARG at top of file).
FROM ${LIVEPEER_IMAGE} AS livepeer-src

FROM gateway AS signer-dmz-local

USER root

# go-livepeer/docker/Dockerfile links against CUDA NPP (libnppig, libnppicc, libnppc).
# Copy only those libs (~46MB), not the full 1.8GB cuda tree.
RUN mkdir -p /usr/local/cuda/targets/x86_64-linux/lib

COPY --from=livepeer-src /usr/local/bin/livepeer /usr/local/bin/livepeer
COPY --from=livepeer-src /usr/local/lib/ /usr/local/lib/
COPY --from=livepeer-src /usr/local/cuda/targets/x86_64-linux/lib/libnppc.so* /usr/local/cuda/targets/x86_64-linux/lib/
COPY --from=livepeer-src /usr/local/cuda/targets/x86_64-linux/lib/libnppig.so* /usr/local/cuda/targets/x86_64-linux/lib/
COPY --from=livepeer-src /usr/local/cuda/targets/x86_64-linux/lib/libnppicc.so* /usr/local/cuda/targets/x86_64-linux/lib/

ENV LD_LIBRARY_PATH=/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/lib

RUN chmod +x /usr/local/bin/livepeer && ldconfig

USER pymthouse

ENV SIGNER_NETWORK=arbitrum-one-mainnet
ENV SIGNER_PORT=8081
ENV ETH_RPC_URL=https://arb1.arbitrum.io/rpc
ENV SIGNER_ETH_ADDR=""
ENV SIGNER_REMOTE_DISCOVERY=0
# Local compose may enable a second CLI-only listener on CLI_PORT (8082).
ENV SIGNER_DMZ_ENABLE_CLI_LISTENER=1

EXPOSE 8080 8082

# Production / Railway: livepeer from official Docker image (default final stage).
ARG LIVEPEER_IMAGE
FROM ${LIVEPEER_IMAGE} AS livepeer-prod

FROM gateway AS signer-dmz

USER root

# go-livepeer links against CUDA NPP (libnppig, libnppicc, libnppc).
RUN mkdir -p /usr/local/cuda/targets/x86_64-linux/lib

COPY --from=livepeer-prod /usr/local/bin/livepeer /usr/local/bin/livepeer
COPY --from=livepeer-prod /usr/local/lib/ /usr/local/lib/
COPY --from=livepeer-prod /usr/local/cuda/targets/x86_64-linux/lib/libnppc.so* /usr/local/cuda/targets/x86_64-linux/lib/
COPY --from=livepeer-prod /usr/local/cuda/targets/x86_64-linux/lib/libnppig.so* /usr/local/cuda/targets/x86_64-linux/lib/
COPY --from=livepeer-prod /usr/local/cuda/targets/x86_64-linux/lib/libnppicc.so* /usr/local/cuda/targets/x86_64-linux/lib/

ENV LD_LIBRARY_PATH=/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/lib

RUN chmod +x /usr/local/bin/livepeer && ldconfig

USER pymthouse

ENV SIGNER_NETWORK=arbitrum-one-mainnet
ENV SIGNER_PORT=8081
ENV ETH_RPC_URL=https://arb1.arbitrum.io/rpc
ENV SIGNER_ETH_ADDR=""
ENV SIGNER_REMOTE_DISCOVERY=0

# Apache: $PORT = signing API; $CLI_PORT (8082) = livepeer-cli routes at / (no /__signer_cli prefix).
# /__signer_cli on $PORT remains for single-port hosts (Railway). Loopback :8081 / :4935 are not public.
ENV SIGNER_DMZ_ENABLE_CLI_LISTENER=1
EXPOSE 8080 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD sh -c 'curl -sf "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1'
