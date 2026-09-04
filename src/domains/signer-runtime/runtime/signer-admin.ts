import type { NextRequest } from "next/server";
import { spawn } from "child_process";
import { DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE } from "@/platform/signer/local-compose";
import { fetchSignerCliStatus } from "@/platform/signer/cli";
import {
  getIssuer,
  getJwksUrlForLocalSignerDmzContainer,
  getPublicOrigin,
} from "@/platform/oidc/issuer-urls";
import { resolveDmzHostPort } from "@/platform/signer/dmz-host-port";
import {
  getDefaultSignerConfig,
  updateDefaultSignerConfig,
} from "../repo/signer-config";
import { parseSignerConfigUpdate, parseTail } from "../service/signer-config";
import { syncSignerStatus } from "./signer-status";

const COMPOSE_START_TIMEOUT_MS = 15 * 60 * 1000;
const LOG_FETCH_TIMEOUT_MS = 10000;

function runShellWithStreamingOutput(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  const { command, cwd, env, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      forceKill.unref?.();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`docker compose timed out after ${timeoutMs}ms`));
      if (signal) return reject(new Error(`docker compose exited via signal ${signal}`));
      if (code !== 0) {
        return reject(
          new Error((stderr || stdout || "").trim() || `docker compose failed (exit ${code ?? "unknown"})`),
        );
      }
      resolve({ stdout, stderr });
    });
  });
}

function getComposeCommand(action: string): string {
  const svc = DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE;
  switch (action) {
    case "start":
    case "restart":
      return `docker compose up -d --build --force-recreate --remove-orphans ${svc}`;
    case "stop":
      return `docker compose stop ${svc}`;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function buildSignerComposeEnv(
  signer:
    | {
        ethRpcUrl: string;
        ethAcctAddr: string | null;
        signerPort: number;
        remoteDiscovery: number;
        orchWebhookUrl: string | null;
        liveAICapReportInterval: string | null;
      }
    | null,
): NodeJS.ProcessEnv {
  const rd = signer?.remoteDiscovery === 1;
  const dmzHostPort = resolveDmzHostPort(signer?.signerPort);
  const issuer = getIssuer();
  return {
    ...process.env,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL || getPublicOrigin(),
    SIGNER_NETWORK: "arbitrum-one-mainnet",
    ETH_RPC_URL: signer?.ethRpcUrl ?? "",
    SIGNER_ETH_ADDR: signer?.ethAcctAddr || "",
    SIGNER_DMZ_HOST_PORT: String(dmzHostPort),
    SIGNER_REMOTE_DISCOVERY: rd ? "1" : "0",
    ORCH_WEBHOOK_URL: rd && signer?.orchWebhookUrl ? signer.orchWebhookUrl : "",
    LIVE_AI_CAP_REPORT_INTERVAL:
      rd && signer?.liveAICapReportInterval ? signer.liveAICapReportInterval : "",
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: issuer,
    JWKS_URI: getJwksUrlForLocalSignerDmzContainer(),
  };
}

export async function readSignerStatus() {
  const liveStatus = await syncSignerStatus();
  const signer = await getDefaultSignerConfig();
  return {
    signer,
    live: {
      reachable: liveStatus.reachable,
      ethAddress: liveStatus.ethAddress,
    },
  };
}

export async function updateSignerStatusConfig(body: Record<string, unknown>) {
  const current = await getDefaultSignerConfig();
  const parsed = parseSignerConfigUpdate({ body, current: current ?? undefined });
  if (!parsed.ok) return parsed;

  await updateDefaultSignerConfig(parsed.updates);
  const updated = await getDefaultSignerConfig();
  return {
    ok: true as const,
    body: {
      signer: updated,
      message: "Config updated. Restart the signer for changes to take effect.",
    },
  };
}

export async function controlSigner(body: Record<string, unknown>) {
  const action = typeof body.action === "string" ? body.action : "";
  const validActions = ["start", "stop", "restart", "sync"] as const;
  if (!validActions.includes(action as (typeof validActions)[number])) {
    return {
      ok: false as const,
      status: 400,
      body: { error: `Invalid action. Must be one of: ${validActions.join(", ")}` },
    };
  }

  try {
    if (action === "sync") {
      const result = await syncSignerStatus();
      return {
        ok: true as const,
        body: {
          action: "sync",
          success: true,
          reachable: result.reachable,
          ethAddress: result.ethAddress,
        },
      };
    }

    const signer = await getDefaultSignerConfig();
    const composeEnv = buildSignerComposeEnv(signer);
    const timeoutMs = action === "start" || action === "restart" ? COMPOSE_START_TIMEOUT_MS : 30000;
    const { stdout, stderr } = await runShellWithStreamingOutput({
      command: getComposeCommand(action),
      cwd: process.cwd(),
      env: composeEnv,
      timeoutMs,
    });

    const now = new Date().toISOString();
    if (action === "stop") {
      await updateDefaultSignerConfig({ status: "stopped" });
    } else {
      await updateDefaultSignerConfig({ status: "running", lastStartedAt: now, lastError: null });
      setTimeout(async () => {
        await syncSignerStatus();
      }, 3000);
    }

    return {
      ok: true as const,
      body: {
        action,
        success: true,
        output: stdout || stderr || "OK",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await updateDefaultSignerConfig({ status: "error", lastError: message });
    return {
      ok: false as const,
      status: 500,
      body: { action, success: false, error: message },
    };
  }
}

export async function readSignerLogs(request: NextRequest) {
  try {
    const responseTail = parseTail(request.nextUrl.searchParams.get("tail"));
    const child = spawn(
      "docker",
      ["compose", "logs", "--no-color", "--tail", String(1000), DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Timed out while fetching signer logs"));
      }, LOG_FETCH_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) return resolve({ stdout, stderr });
        const details =
          stderr.trim() ||
          stdout.trim() ||
          (code === null && signal
            ? `docker compose logs terminated by signal ${signal}`
            : `docker compose logs exited with code ${String(code)}`);
        reject(new Error(details));
      });
    });

    const raw = result.stdout && result.stderr ? `${result.stdout}\n${result.stderr}` : `${result.stdout}${result.stderr}`;
    const lines = raw
      .split("\n")
      .map((line) => line.replace(/^[a-z0-9._-]+-\d+\s+\|\s*/i, ""))
      .filter((line) => line.trim())
      .slice(-responseTail);
    return { lines, count: lines.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch logs";
    return { lines: [message], count: 1, error: true };
  }
}

export async function readSignerCliStatus() {
  return fetchSignerCliStatus();
}
