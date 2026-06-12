import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { signerConfig, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, hasScope } from "@/lib/auth";
import { isManagedRemoteSigner, syncSignerStatus } from "@/lib/signer-proxy";
import { DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE } from "@/lib/signer-local-compose";
import {
  getIssuer,
  getJwksUrlForLocalSignerDmzContainer,
  getPublicOrigin,
} from "@/lib/oidc/issuer-urls";
import { resolveDmzHostPort } from "@/lib/signer-dmz-host-port";
import { spawn } from "child_process";

/** `docker compose up --build` can take minutes on a cold build (go-livepeer + Apache image). */
const COMPOSE_START_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Run a shell command with streamed stdout/stderr (no exec maxBuffer cap).
 * Kills the child after `timeoutMs` (SIGTERM, then SIGKILL).
 */
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
      if (timedOut) {
        reject(new Error(`docker compose timed out after ${timeoutMs}ms`));
        return;
      }
      if (signal) {
        reject(new Error(`docker compose exited via signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            (stderr || stdout || "").trim() ||
              `docker compose failed (exit ${code ?? "unknown"})`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * POST /api/v1/signer/control -- Control plane for the signer container
 *
 * Body: { action: "start" | "stop" | "restart" | "sync" }
 */
export async function POST(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const action = body.action;

  const validActions = ["start", "stop", "restart", "sync"];
  if (!validActions.includes(action)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${validActions.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    if (action === "sync") {
      const result = await syncSignerStatus();
      return NextResponse.json({
        action: "sync",
        success: true,
        reachable: result.reachable,
        ethAddress: result.ethAddress,
      });
    }

    const signerRows = await db
      .select()
      .from(signerConfig)
      .where(eq(signerConfig.id, "default"))
      .limit(1);
    const signerForMode = signerRows[0];
    if (isManagedRemoteSigner(signerForMode)) {
      return NextResponse.json(
        {
          action,
          success: false,
          error:
            "Start/stop/restart require a local Docker signer. This deployment uses a remote signer DMZ — use Railway or redeploy there.",
        },
        { status: 400 },
      );
    }

    // Docker Compose control actions
    const signer = signerForMode;
    const composeCmd = getComposeCommand(action);
    const composeEnv = buildSignerComposeEnv(signer);
    const timeoutMs =
      action === "start" || action === "restart"
        ? COMPOSE_START_TIMEOUT_MS
        : 30000;
    const { stdout, stderr } = await runShellWithStreamingOutput({
      command: composeCmd,
      cwd: process.cwd(),
      env: composeEnv,
      timeoutMs,
    });

    // Update status based on action
    const now = new Date().toISOString();
    if (action === "stop") {
      await db
        .update(signerConfig)
        .set({ status: "stopped" })
        .where(eq(signerConfig.id, "default"));
    } else {
      await db
        .update(signerConfig)
        .set({ status: "running", lastStartedAt: now, lastError: null })
        .where(eq(signerConfig.id, "default"));

      // Wait a moment then sync to get the eth address
      setTimeout(async () => {
        await syncSignerStatus();
      }, 3000);
    }

    return NextResponse.json({
      action,
      success: true,
      output: stdout || stderr || "OK",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[signer-control] ${action} failed:`, message);

    await db
      .update(signerConfig)
      .set({ status: "error", lastError: message })
      .where(eq(signerConfig.id, "default"));

    return NextResponse.json(
      { action, success: false, error: message },
      { status: 500 }
    );
  }
}

function getComposeCommand(action: string): string {
  const svc = DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE;
  switch (action) {
    case "start":
    case "restart":
      // build-local-signer.sh builds go-livepeer (lpclearinghouse) then signer-dmz.
      return `./scripts/build-local-signer.sh && docker compose up -d --force-recreate --remove-orphans ${svc}`;
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
        ethAddress: string | null;
        signerPort: number;
        remoteDiscovery: number;
        orchWebhookUrl: string | null;
        liveAICapReportInterval: string | null;
      }
    | undefined
): NodeJS.ProcessEnv {
  const rd = signer?.remoteDiscovery === 1;
  const dmzHostPort = resolveDmzHostPort(signer?.signerPort);
  // Apache iss/aud must match issueSignerDmzToken (getIssuer); JWKS must be the
  // same key material (local oidc:seed), reachable from Docker via host.docker.internal.
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
      rd && signer?.liveAICapReportInterval
        ? signer.liveAICapReportInterval
        : "",
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: issuer,
    JWKS_URI: getJwksUrlForLocalSignerDmzContainer(),
  };
}

async function getAdminUser(request: NextRequest) {
  const oauthSession = await getServerSession(authOptions);
  if (oauthSession?.user) {
    const sessionUser = oauthSession.user as Record<string, unknown>;
    if (sessionUser.id) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, sessionUser.id as string))
        .limit(1);
      const user = rows[0];
      if (user?.role !== "admin") return null;
      return user;
    }
  }

  const auth = await authenticateRequest(request);
  if (auth && hasScope(auth.scopes, "admin") && auth.userId) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);
    const user = rows[0];
    if (user?.role !== "admin") return null;
    return user;
  }

  return null;
}
