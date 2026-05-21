# Apache + mod_authnz_jwt in front of go-livepeer (DMZ). Targets:
#   gateway   — Apache only; set SIGNER_UPSTREAM (e.g. http://signer:8081) for docker compose.
#   signer-dmz — includes livepeer; image intended to be built once, pushed, and deployed by digest/tag.

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

RUN ldconfig && \
    printf '%s\n' 'LoadModule auth_jwt_module /usr/lib/apache2/modules/mod_authnz_jwt.so' \
      >/etc/apache2/mods-available/authnz_jwt.load && \
    a2enmod authnz_jwt && \
    a2enmod alias proxy proxy_http headers rewrite authn_core authz_core

COPY infra/docker/signer-dmz/scripts/jwks_to_pem.py /opt/pymthouse/scripts/jwks_to_pem.py
COPY infra/docker/signer-dmz/apache/ports.conf.in /etc/apache2/templates/ports.conf.in
COPY infra/docker/signer-dmz/apache/signer-dmz.conf.in /etc/apache2/templates/signer-dmz.conf.in
COPY infra/docker/signer-dmz/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /opt/pymthouse/scripts/jwks_to_pem.py

RUN mkdir -p /var/www/static && printf "OK\n" > /var/www/static/healthz

# Create an unprivileged user, pre-create all runtime-writable paths, and hand them off.
# Apache on Debian reads /etc/apache2/envvars for APACHE_RUN_USER/GROUP; override to the app user
# so the (non-root) master does not try to setuid.
RUN groupadd --system --gid "${APP_GID}" "${APP_USER}" && \
    useradd --system --uid "${APP_UID}" --gid "${APP_GID}" \
      --home-dir /home/${APP_USER} --create-home --shell /usr/sbin/nologin "${APP_USER}" && \
    mkdir -p /run/jwt /run/apache2 /var/lock/apache2 /var/log/apache2 /data && \
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
      /var/www/static \
      /opt/pymthouse \
      /data && \
    # Allow the unprivileged user to bind to privileged ports (e.g. PORT=80 in compose)
    # without giving the whole container root. Safe because the cap is file-scoped.
    setcap cap_net_bind_service=+ep /usr/sbin/apache2

USER ${APP_USER}

ENTRYPOINT ["/entrypoint.sh"]

FROM gateway AS signer-dmz

USER root

# CI-built linux-amd64 tarball mirrored at build.livepeer.live (same bytes as GitHub Actions artifacts).
# Source artifact: https://github.com/livepeer/go-livepeer/actions/runs/25226599716/artifacts/6796975695
# Node reports: Livepeer Node Version 0.8.10-0a1919e0
ARG LIVEPEER_COMMIT=0a1919e0c58986375df158433445563a45a04df8
ARG LIVEPEER_SHA256=0ba7b032a95bf1969b6983dfe065bc802105d982242e141840df422be1a6bade

RUN apt-get update && apt-get install -y --no-install-recommends wget && \
    wget -q "https://build.livepeer.live/go-livepeer/${LIVEPEER_COMMIT}/livepeer-linux-amd64.tar.gz" -O livepeer-linux-amd64.tar.gz && \
    echo "${LIVEPEER_SHA256}  livepeer-linux-amd64.tar.gz" | sha256sum -c - && \
    tar -xzf livepeer-linux-amd64.tar.gz && \
    mv livepeer-linux-amd64/livepeer /usr/local/bin/livepeer && \
    chmod +x /usr/local/bin/livepeer && \
    rm -rf livepeer-linux-amd64.tar.gz livepeer-linux-amd64 && \
    apt-get purge -y --auto-remove wget && \
    rm -rf /var/lib/apt/lists/*

# /data was created in the gateway stage and already chown'd; nothing more to do here.

USER pymthouse

ENV SIGNER_NETWORK=arbitrum-one-mainnet
ENV SIGNER_PORT=8081
ENV ETH_RPC_URL=https://arb1.arbitrum.io/rpc
ENV SIGNER_ETH_ADDR=""
ENV SIGNER_REMOTE_DISCOVERY=0

# Apache listens on $PORT (Railway sets this, default 8080) and on $CLI_PORT (8082).
# go-livepeer binds loopback :8081 / :4935 only — they must not be the public edge port.
EXPOSE 8080 8082
