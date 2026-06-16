# Clearinghouse Kafka bus (Redpanda, production mode) for Railway private networking.
# Single broker for now; production mode keeps fsync durability for billing events.
FROM redpandadata/redpanda:v24.2.4

ENV CLUSTER_ID=ca497efe-9f82-4b84-890b-d9969a9a2e1c

# Base image data dir is owned by the unprivileged redpanda user (uid 101).
USER redpanda

CMD ["redpanda", "start", \
  "--kafka-addr", "internal://0.0.0.0:9092", \
  "--advertise-kafka-addr", "internal://kafka.railway.internal:9092", \
  "--smp", "1", \
  "--memory", "512M", \
  "--reserve-memory", "0M", \
  "--overprovisioned", \
  "--set", "redpanda.auto_create_topics_enabled=true"]
