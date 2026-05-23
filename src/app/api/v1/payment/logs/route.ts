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

const DEFAULT_TAIL = 50;
const MAX_TAIL = 1000;
const LOG_FETCH_TIMEOUT_MS = 10000;

/**
 * GET /api/v1/payment/logs -- Fetch recent payment-daemon container logs
 */
export async function GET(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const responseTail = parseTail(request.nextUrl.searchParams.get("tail"));

  try {
    const { stdout, stderr } = await getPaymentLogs();
    const raw = stdout && stderr ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;
    const lines = raw
      .split("\n")
      .map((line) => line.replace(/^[a-z0-9._-]+-\d+\s+\|\s*/i, ""))
      .filter((line) => line.trim())
      .slice(-responseTail);

    return NextResponse.json({ lines, count: lines.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch logs";
    return NextResponse.json({ lines: [message], count: 1, error: true });
  }
}

function parseTail(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) {
    return DEFAULT_TAIL;
  }

  const parsedTail = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsedTail) || parsedTail < 1) {
    return DEFAULT_TAIL;
  }

  return Math.min(parsedTail, MAX_TAIL);
}

function getPaymentLogs(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "logs",
        "--no-color",
        "--tail",
        String(MAX_TAIL),
        ...PAYMENT_DAEMON_COMPOSE_SERVICES,
      ],
      {
        cwd: PAYMENT_DAEMON_COMPOSE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
      reject(new Error("Timed out while fetching payment-daemon logs"));
    }, LOG_FETCH_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const trimmedStderr = stderr.trim();
      const trimmedStdout = stdout.trim();
      const exitDetails =
        code === null && signal
          ? `docker compose logs terminated by signal ${signal}`
          : `docker compose logs exited with code ${String(code)}`;
      const details = trimmedStderr || trimmedStdout || exitDetails;
      reject(new Error(details));
    });
  });
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
