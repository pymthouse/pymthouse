import { NextResponse } from "next/server";
import { db } from "@/db/index";
import { signerConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { withAdminGuard } from "@/lib/api-guards";
import { spawn } from "node:child_process";
import { DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE } from "@/lib/signer-local-compose";
import { isManagedRemoteSigner } from "@/lib/signer-proxy";

const DEFAULT_TAIL = 50;
const MAX_TAIL = 1000;
const LOG_FETCH_TIMEOUT_MS = 10000;
/** Absolute path so spawn does not rely on a writable PATH (Sonar S4036). */
const DOCKER_BIN = "/usr/bin/docker";
const SAFE_PATH = "/usr/bin:/bin";

/**
 * GET /api/v1/signer/logs -- Fetch recent container logs
 */
export const GET = withAdminGuard(async (request) => {
  const responseTail = parseTail(request.nextUrl.searchParams.get("tail"));

  const signerRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  if (isManagedRemoteSigner(signerRows[0])) {
    return NextResponse.json({
      lines: [
        "Container logs are only available for a local Docker signer.",
        "Use your deployment provider (e.g. Railway) to view remote signer logs.",
      ],
      count: 2,
      remote: true,
    });
  }

  try {
    const { stdout, stderr } = await getSignerLogs();

    const out = stdout || "";
    const err = stderr || "";
    const raw = out && err ? `${out}\n${err}` : `${out}${err}`;
    // Strip the container name prefix from each line for cleaner output
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
});

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

function getSignerLogs(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      DOCKER_BIN,
      [
        "compose",
        "logs",
        "--no-color",
        "--tail",
        String(MAX_TAIL),
        DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: SAFE_PATH },
        stdio: ["ignore", "pipe", "pipe"],
      }
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
      reject(new Error("Timed out while fetching signer logs"));
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

