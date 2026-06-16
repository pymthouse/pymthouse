# OpenMeter Benthos collector: Kafka signed-ticket events -> Konnect ingest.
# Pinned by digest for immutability (corresponds to tag v1.0.0-beta.50).
FROM ghcr.io/openmeterio/benthos-collector@sha256:121082321b1a9e5ddb3e76fae7016db846f22c1330342ae544e1a430dcf4a64a

COPY deploy/collector.yaml /config.yaml

CMD ["-c", "/config.yaml"]
