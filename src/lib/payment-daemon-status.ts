import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  payerGetDepositInfo,
  payerHealth,
  payerIdentify,
} from "@/lib/signer-lpnm/payer-daemon-client";
import {
  defaultPaymentCapabilityOffering,
  resolveDiscoveryOrchServiceUrl,
  resolvePayerDaemonSocketPath,
  resolveTicketParamsBaseUrlOverride,
} from "@/lib/signer-lpnm/socket-resolver";
import {
  PAYMENT_DAEMON_COMPOSE_DIR,
  PAYMENT_DAEMON_COMPOSE_SERVICES,
} from "@/lib/payment-local-compose";

const execAsync = promisify(exec);

export interface PaymentDaemonAdminConfig {
  socketPath: string;
  socketSource: "env" | "default";
  ticketParamsBaseUrl: string;
  discoveryOrchUrl: string;
  capability: string;
  offering: string;
  composeDir: string;
}

export interface PaymentDaemonStatus {
  reachable: boolean;
  socketPath: string;
  socketExists: boolean;
  healthStatus: string | null;
  ethAddress: string | null;
  deposit: string | null;
  reserve: string | null;
  withdrawRound: string | null;
  containerRunning: boolean;
  senderContainerRunning: boolean;
  registryContainerRunning: boolean;
  fetchedAt: string;
  error: string | null;
}

function bytesToDecimalString(bytes: Buffer): string {
  if (!bytes.length) return "0";
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }
  return value.toString();
}

function addressToHex(address: Buffer): string {
  if (!address.length) return "";
  return `0x${Buffer.from(address).toString("hex")}`;
}

export function getPaymentDaemonAdminConfig(): PaymentDaemonAdminConfig {
  const fromEnv = process.env.LPNM_PAYER_DAEMON_SOCKET?.trim();
  const { capability, offering } = defaultPaymentCapabilityOffering();
  return {
    socketPath: resolvePayerDaemonSocketPath(null),
    socketSource: fromEnv ? "env" : "default",
    ticketParamsBaseUrl: resolveTicketParamsBaseUrlOverride(),
    discoveryOrchUrl: resolveDiscoveryOrchServiceUrl(),
    capability,
    offering,
    composeDir: PAYMENT_DAEMON_COMPOSE_DIR,
  };
}

async function getComposeServiceState(
  service: string,
): Promise<{ running: boolean; state: string }> {
  try {
    const { stdout } = await execAsync(
      `docker compose ps --format json ${service}`,
      { cwd: PAYMENT_DAEMON_COMPOSE_DIR, timeout: 5000 },
    );
    if (!stdout.trim()) {
      return { running: false, state: "missing" };
    }
    const info = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const state = String(info.State ?? info.state ?? "").toLowerCase();
    return { running: state === "running", state: state || "unknown" };
  } catch {
    return { running: false, state: "unknown" };
  }
}

export async function fetchPaymentDaemonStatus(): Promise<PaymentDaemonStatus> {
  const config = getPaymentDaemonAdminConfig();
  const socketPath = path.resolve(config.socketPath);
  const socketExists = fs.existsSync(socketPath);

  const [senderState, registryState] = await Promise.all([
    getComposeServiceState(PAYMENT_DAEMON_COMPOSE_SERVICES[0]),
    getComposeServiceState(PAYMENT_DAEMON_COMPOSE_SERVICES[1]),
  ]);

  const containerRunning = senderState.running || registryState.running;
  let reachable = false;
  let healthStatus: string | null = null;
  let ethAddress: string | null = null;
  let deposit: string | null = null;
  let reserve: string | null = null;
  let withdrawRound: string | null = null;
  let error: string | null = null;

  if (!socketExists) {
    error = `Unix socket not found: ${socketPath}`;
  } else {
    try {
      const health = await payerHealth(socketPath);
      healthStatus = health.status;
      reachable = health.status.toLowerCase() === "ok";

      const [identify, depositInfo] = await Promise.all([
        payerIdentify(socketPath),
        payerGetDepositInfo(socketPath),
      ]);
      ethAddress = addressToHex(identify.address);
      deposit = bytesToDecimalString(depositInfo.deposit);
      reserve = bytesToDecimalString(depositInfo.reserve);
      withdrawRound = depositInfo.withdrawRound || "0";
    } catch (err) {
      error = err instanceof Error ? err.message : "PayerDaemon unreachable";
    }
  }

  return {
    reachable,
    socketPath,
    socketExists,
    healthStatus,
    ethAddress,
    deposit,
    reserve,
    withdrawRound,
    containerRunning,
    senderContainerRunning: senderState.running,
    registryContainerRunning: registryState.running,
    fetchedAt: new Date().toISOString(),
    error,
  };
}
