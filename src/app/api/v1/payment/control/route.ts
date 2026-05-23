import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, hasScope } from "@/lib/auth";
import { spawn } from "child_process";
import {
  PAYMENT_DAEMON_COMPOSE_DIR,
  PAYMENT_DAEMON_COMPOSE_SERVICES,
} from "@/lib/payment-local-compose";
import { fetchPaymentDaemonStatus } from "@/lib/payment-daemon-status";

const COMPOSE_START_TIMEOUT_MS = 10 * 60 * 1000;

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
 * POST /api/v1/payment/control -- Control plane for payment-daemon compose stack
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
      { status: 400 },
    );
  }

  try {
    if (action === "sync") {
      const result = await fetchPaymentDaemonStatus();
      return NextResponse.json({
        action: "sync",
        success: true,
        reachable: result.reachable,
        ethAddress: result.ethAddress,
        containerRunning: result.containerRunning,
      });
    }

    const composeCmd = getComposeCommand(action);
    const timeoutMs =
      action === "start" || action === "restart"
        ? COMPOSE_START_TIMEOUT_MS
        : 30000;
    const { stdout, stderr } = await runShellWithStreamingOutput({
      command: composeCmd,
      cwd: PAYMENT_DAEMON_COMPOSE_DIR,
      env: process.env,
      timeoutMs,
    });

    return NextResponse.json({
      action,
      success: true,
      output: stdout || stderr || "OK",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[payment-control] ${action} failed:`, message);
    return NextResponse.json(
      { action, success: false, error: message },
      { status: 500 },
    );
  }
}

function getComposeCommand(action: string): string {
  const services = PAYMENT_DAEMON_COMPOSE_SERVICES.join(" ");
  switch (action) {
    case "start":
    case "restart":
      return `docker compose up -d --force-recreate --remove-orphans ${services}`;
    case "stop":
      return `docker compose stop ${services}`;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
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
