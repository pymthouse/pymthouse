# OpenMeter API + workers share this image (config baked for Railway private DNS).
# Build context: pymthouse repo root (see docker-compose.openmeter.railway.yml).
FROM ghcr.io/openmeterio/openmeter:v1.0.0-beta.228
COPY docker/openmeter/config.railway.yaml /etc/openmeter/config.railway.yaml
COPY deploy/openmeter/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER nobody
ENTRYPOINT ["/entrypoint.sh"]
