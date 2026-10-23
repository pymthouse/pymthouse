import { eq } from "drizzle-orm";
import { getSenderInfo } from "@/platform/signer/cli";
import { issueSignerDmzToken } from "@/platform/signer/dmz-token";
import { getIssuer } from "@/platform/oidc/issuer-urls";
import { DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE } from "@/platform/signer/local-compose";
import { updateDefaultSignerConfig } from "../repo/signer-config";
import { getDefaultSigner } from "../repo/signer-routing";

const SIGNER_SYNC_DMZ_SUBJECT = "pymthouse-signer-sync";

export function getSignerUrl(signer?: {
  signerPort: number;
  signerUrl: string | null;
} | null): string {
  const testSignerUrl =
    process.env.NODE_ENV === "test"
      ? process.env.PYMTHOUSE_TEST_SIGNER_URL
      : undefined;
  if (testSignerUrl && testSignerUrl.trim() !== "") {
    return testSignerUrl.replace(/\/+$/, "");
  }

  const legacyBareSignerPort = 8081;
  const rawPort = signer?.signerPort ?? 8080;
  const port = rawPort === legacyBareSignerPort ? 8080 : rawPort;
  const base = signer?.signerUrl || process.env.SIGNER_INTERNAL_URL || `http://127.0.0.1:${port}`;
  return base.replace(/\/+$/, "");
}

async function readSignerUpstreamBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      error: "Signer DMZ returned a non-JSON body (often Apache auth failure)",
      upstreamStatus: response.status,
      detail: text.slice(0, 800),
    };
  }
}

export async function probeSignerHttpReachability(
  signerUrl: string,
): Promise<{ reachable: boolean; ethAddress?: string }> {
  const timeoutMs = 5000;

  const parseEthFromStatus = async (response: Response): Promise<string | undefined> => {
    if (!response.ok) return undefined;
    const data = (await readSignerUpstreamBody(response)) as Record<string, unknown>;
    return (
      (typeof data.Address === "string" && data.Address) ||
      (typeof data.address === "string" && data.address) ||
      undefined
    );
  };

  const fetchStatus = async (headers: Record<string, string>) => {
    const response = await fetch(`${signerUrl}/status`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const addr = await parseEthFromStatus(response);
    return { ok: response.ok, addr };
  };

  try {
    const health = await fetch(`${signerUrl}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (health.ok) {
      if (process.env.SIGNER_DMZ_FORWARD_JWT !== "false") {
        try {
          const token = await issueSignerDmzToken({
            gate: "http",
            subject: SIGNER_SYNC_DMZ_SUBJECT,
          });
          const { ok, addr } = await fetchStatus({ Authorization: `Bearer ${token}` });
          if (ok) return { reachable: true, ethAddress: addr };
        } catch {
          // continue
        }
      }
      try {
        const { ok, addr } = await fetchStatus({});
        if (ok) return { reachable: true, ethAddress: addr };
      } catch {
        // continue
      }
      return { reachable: false, ethAddress: undefined };
    }
  } catch {
    // try /status without healthz
  }

  if (process.env.SIGNER_DMZ_FORWARD_JWT !== "false") {
    try {
      const token = await issueSignerDmzToken({
        gate: "http",
        subject: SIGNER_SYNC_DMZ_SUBJECT,
      });
      const { ok, addr } = await fetchStatus({ Authorization: `Bearer ${token}` });
      if (ok) return { reachable: true, ethAddress: addr };
    } catch {
      // continue
    }
  }

  try {
    const { ok, addr } = await fetchStatus({});
    if (ok) return { reachable: true, ethAddress: addr };
  } catch {
    // unreachable
  }

  return { reachable: false, ethAddress: undefined };
}

export async function syncSignerStatus(): Promise<{
  reachable: boolean;
  ethAddress?: string;
  containerRunning?: boolean;
}> {
  let reachable = false;
  let ethAddress: string | undefined;

  try {
    const defaultSigner = await getDefaultSigner();
    const probe = await probeSignerHttpReachability(getSignerUrl(defaultSigner));
    reachable = probe.reachable;
    ethAddress = probe.ethAddress;
  } catch {
    // ignore
  }

  let containerRunning = false;
  let lastError: string | null = null;
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(
      `docker compose ps --format json ${DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE}`,
      { cwd: process.cwd(), timeout: 5000 },
    );

    if (stdout.trim()) {
      const info = JSON.parse(stdout.trim()) as Record<string, unknown>;
      const state = String(info.State || info.state || "").toLowerCase();
      containerRunning = state === "running";

      if (!containerRunning && state) {
        lastError = `Container state: ${state}`;
        try {
          const { stdout: logs } = await execAsync(
            `docker compose logs --no-color --tail=3 ${DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE} 2>&1`,
            { cwd: process.cwd(), timeout: 5000 },
          );
          const errorLine = logs
            .split("\n")
            .filter((line) => line.includes("Error") || line.includes("error"))
            .pop();
          if (errorLine) {
            lastError = errorLine.replace(/^[a-z0-9._-]+-\d+\s+\|\s*/i, "");
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  const status = reachable ? "running" : containerRunning ? "running" : "stopped";
  if (reachable) lastError = null;

  const dbSet: Record<string, unknown> = {
    status,
    ethAddress: ethAddress || null,
    lastError,
  };
  const senderInfo = await getSenderInfo();
  if (senderInfo) {
    dbSet.depositWei = senderInfo.deposit;
    dbSet.reserveWei = senderInfo.reserve.fundsRemaining;
  }

  await updateDefaultSignerConfig(dbSet);
  return { reachable, ethAddress, containerRunning };
}

export function formatDmzTokenForLog(authz: string | undefined) {
  const token = authz?.startsWith("Bearer ") ? authz.slice(7) : undefined;
  if (!token) {
    return { expected_issuer: getIssuer() };
  }

  const parts = token.split(".");
  const decodePart = (segment: string): Record<string, unknown> | undefined => {
    try {
      const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
      return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const header = parts.length >= 1 ? decodePart(parts[0]) : undefined;
  const payload = parts.length >= 2 ? decodePart(parts[1]) : undefined;
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload?.exp === "number" ? payload.exp : undefined;
  const nbf = typeof payload?.nbf === "number" ? payload.nbf : undefined;
  const sub = payload?.sub;
  const subString = sub === undefined || sub === null ? "" : String(sub);

  return {
    expected_issuer: getIssuer(),
    header_kid: header?.kid,
    header_alg: header?.alg,
    claim_iss: payload?.iss,
    claim_aud: payload?.aud,
    claim_sub_masked:
      subString.length === 0 ? undefined : subString.length <= 4 ? "****" : `…${subString.slice(-4)}`,
    claim_sub_length: subString.length || undefined,
    claim_scope: payload?.scope,
    claim_exp: exp,
    claim_nbf: nbf,
    now,
    exp_in_seconds: exp !== undefined ? exp - now : undefined,
    nbf_delta_seconds: nbf !== undefined ? nbf - now : undefined,
  };
}
