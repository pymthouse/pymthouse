# OpenMeter Benthos collector: Kafka signed-ticket events -> Konnect ingest.
# Pinned by digest for immutability (corresponds to tag v1.0.0-beta.50).
FROM ghcr.io/openmeterio/benthos-collector@sha256:121082321b1a9e5ddb3e76fae7016db846f22c1330342ae544e1a430dcf4a64a

COPY collector.yaml /config.yaml

# Run as the unprivileged nobody user; /config.yaml is world-readable.
USER 65534:65534

# beta.50 ships no ENTRYPOINT (default CMD is `/bin/bash -c benthos`), so the
# bare `-c /config.yaml` CMD below would exec a program literally named `-c`.
# Pin benthos as the entrypoint and pass the config path as its arguments.
ENTRYPOINT ["benthos"]
CMD ["-c", "/config.yaml"]
