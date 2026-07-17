import { db } from "@/db/index";
import { developerApps, oidcClients, signerConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { issueSignerDmzToken } from "./signer-dmz-token";
import { fetchSignerCliStatus, getSenderInfo } from "./signer-cli";
import { DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE } from "./signer-local-compose";
import {
  normalizeSignerBaseUrl,
  probeSignerHttpReachability as sdkProbeSignerHttpReachability,
  resolveSignerBaseUrl,
} from "@pymthouse/builder-sdk/signer/server";

/** Minimal signer row fields used for URL resolution (env overrides DB). */
export type SignerUrlInput = Pick<
  typeof signerConfig.$inferSelect,
  "signerUrl" | "signerPort"
>;

export async function getDefaultSigner() {
  const signerRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  return signerRows[0] ?? null;
}

export async function resolveDeveloperAppIdFromAuthAppId(
  authAppId: string | null | undefined,
): Promise<string | null> {
  if (!authAppId?.trim()) return null;
  const trimmed = authAppId.trim();

  const byOidc = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);
  return byOidc[0]?.id ?? null;
}

export async function getSignerRoutingContext(authAppId?: string | null) {
  const signer = await getDefaultSigner();
  const providerAppId = await resolveDeveloperAppIdFromAuthAppId(authAppId);
  return { signer, providerAppId };
}

export async function isSignerOperational(
  signer: typeof signerConfig.$inferSelect | null | undefined,
): Promise<boolean> {
  if (!signer) {
    return false;
  }
  if (signer.status === "running") {
    return true;
  }
  const senderInfo = await getSenderInfo();
  return senderInfo !== null;
}

/** Signer "version" a client is routed to: the newer A/B DMZ or the stable one. */
export type SignerVersion = "latest" | "stable";

/**
 * Public client ids (`app_*`) that should be routed to the "latest" signer DMZ,
 * parsed from LATEST_SIGNER_APPS (comma/space separated). Everyone else uses the
 * stable production signer.
 */
export function getLatestSignerApps(): Set<string> {
  return new Set(
    (process.env.LATEST_SIGNER_APPS ?? "")
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** True when this app's public client id is opted in to the latest signer. */
export function isLatestSignerApp(appClientId?: string | null): boolean {
  const id = appClientId?.trim();
  if (!id) {
    return false;
  }
  return getLatestSignerApps().has(id);
}

/** Which signer version an app is routed to (defaults to stable). */
export function getSignerVersionForApp(appClientId?: string | null): SignerVersion {
  return isLatestSignerApp(appClientId) ? "latest" : "stable";
}

/** Stable production signer DMZ base URL (the default for all apps). */
function getStableSignerApiUrl(): string {
  const explicit =
    process.env.PYMTHOUSE_CLIENT_SIGNER_API_URL?.trim() ||
    process.env.PYMTHOUSE_SIGNER_URL?.trim() ||
    process.env.SIGNER_PUBLIC_URL?.trim();
  if (explicit) {
    return normalizeSignerBaseUrl(explicit);
  }
  return getSignerUrl();
}

/**
 * "Latest" A/B signer DMZ base URL (the pymthouse-signer-test service), or empty
 * when unconfigured — in which case opted-in apps safely fall back to stable.
 */
function getLatestSignerApiUrl(): string {
  const explicit = process.env.SIGNER_LATEST_URL?.trim();
  return explicit ? normalizeSignerBaseUrl(explicit) : "";
}

/**
 * Public remote signer DMZ base URL for clients (gateway, builder-sdk).
 * Signing goes directly to the DMZ — not through PymtHouse /api/signer/*.
 *
 * Apps in LATEST_SIGNER_APPS are routed to the "latest" signer DMZ
 * (SIGNER_LATEST_URL) when it is configured; all other apps — and any
 * call without an app client id — get the stable production signer.
 */
export function getClientSignerApiUrl(appClientId?: string | null): string {
  if (isLatestSignerApp(appClientId)) {
    const latest = getLatestSignerApiUrl();
    if (latest) {
      return latest;
    }
  }
  return getStableSignerApiUrl();
}

export type SignerUrlSource = "env" | "saved" | "default";

const LOCAL_SIGNER_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "host.docker.internal",
  "::1",
]);

export function isRemoteSignerHttpUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !LOCAL_SIGNER_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function isManagedRemoteSigner(
  signer?: SignerUrlInput | null,
): boolean {
  return isRemoteSignerHttpUrl(getSignerUrl(signer));
}

export function getSignerUrlSource(
  signer?: SignerUrlInput | null,
): SignerUrlSource {
  if (process.env.SIGNER_INTERNAL_URL?.trim()) return "env";
  if (signer?.signerUrl?.trim()) return "saved";
  return "default";
}

export function getSignerUrl(signer?: SignerUrlInput | null): string {
  const testSignerUrl =
    process.env.NODE_ENV === "test"
      ? process.env.PYMTHOUSE_TEST_SIGNER_URL
      : undefined;
  return resolveSignerBaseUrl({
    testSignerUrl,
    envUrl: process.env.SIGNER_INTERNAL_URL,
    storedUrl: signer?.signerUrl,
    storedPort: signer?.signerPort ?? undefined,
    defaultPort: 8080,
  });
}

function getDmzTokenForSubject(subject: string) {
  return issueSignerDmzToken({ gate: "http", subject });
}

const SIGNER_SYNC_DMZ_SUBJECT = "pymthouse-signer-sync";

export async function probeSignerHttpReachability(
  signerUrl: string,
): Promise<{ reachable: boolean; ethAddress?: string }> {
  return sdkProbeSignerHttpReachability({
    signerUrl,
    getDmzToken: getDmzTokenForSubject,
    probeSubject: SIGNER_SYNC_DMZ_SUBJECT,
    forwardJwt: process.env.SIGNER_DMZ_FORWARD_JWT !== "false",
  });
}

export async function syncSignerStatus(): Promise<{
  reachable: boolean;
  ethAddress?: string;
  containerRunning?: boolean;
}> {
  const defaultSigner = await getDefaultSigner();
  const signerUrl = getSignerUrl(defaultSigner);

  const [httpProbe, cliStatus] = await Promise.all([
    probeSignerHttpReachability(signerUrl).catch(() => ({
      reachable: false as const,
      ethAddress: undefined as string | undefined,
    })),
    fetchSignerCliStatus(),
  ]);

  const reachable = httpProbe.reachable || cliStatus.reachable;
  const ethAddress =
    httpProbe.ethAddress ||
    cliStatus.ethAddress ||
    defaultSigner?.ethAcctAddr ||
    undefined;

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
      const info = JSON.parse(stdout.trim());
      const state = (info.State || info.state || "").toLowerCase();
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
            .filter((l) => l.includes("Error") || l.includes("error"))
            .pop();
          if (errorLine) {
            lastError = errorLine.replace(
              /^[a-z0-9._-]+-\d+\s+\|\s*/i,
              "",
            );
          }
        } catch {}
      }
    }
  } catch {}

  let status: string;
  if (reachable) {
    status = "running";
    lastError = null;
  } else if (containerRunning) {
    status = "running";
  } else {
    status = "stopped";
  }

  const dbSet: Record<string, unknown> = {
    status,
    ethAddress: ethAddress || null,
    lastError,
  };
  if (cliStatus.senderInfo) {
    dbSet.depositWei = cliStatus.senderInfo.deposit;
    dbSet.reserveWei = cliStatus.senderInfo.reserve.fundsRemaining;
  }

  await db
    .update(signerConfig)
    .set(dbSet)
    .where(eq(signerConfig.id, "default"));

  return { reachable, ethAddress, containerRunning };
}
