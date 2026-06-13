# OpenMeter Benthos collector: Kafka signed-ticket events -> Konnect ingest.
FROM ghcr.io/openmeterio/benthos-collector:latest

COPY deploy/collector.yaml /config.yaml

CMD ["-c", "/config.yaml"]
