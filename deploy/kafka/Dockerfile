# Clearinghouse Kafka bus (Redpanda dev-container mode) for Railway private networking.
FROM redpandadata/redpanda:v24.2.4

ENV CLUSTER_ID=ca497efe-9f82-4b84-890b-d9969a9a2e1c

CMD ["redpanda", "start", \
  "--kafka-addr", "internal://0.0.0.0:9092", \
  "--advertise-kafka-addr", "internal://kafka.railway.internal:9092", \
  "--mode", "dev-container", \
  "--smp", "1", \
  "--memory", "512M", \
  "--overprovisioned"]
