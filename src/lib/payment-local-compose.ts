import path from "node:path";

/** Directory containing `docker/payment-daemon/docker-compose.yaml`. */
export const PAYMENT_DAEMON_COMPOSE_DIR = path.join(
  process.cwd(),
  "docker",
  "payment-daemon",
);

export const PAYMENT_DAEMON_SENDER_SERVICE = "payment-daemon-sender" as const;
export const PAYMENT_DAEMON_REGISTRY_SERVICE =
  "service-registry-daemon" as const;

export const PAYMENT_DAEMON_COMPOSE_SERVICES = [
  PAYMENT_DAEMON_SENDER_SERVICE,
  PAYMENT_DAEMON_REGISTRY_SERVICE,
] as const;
