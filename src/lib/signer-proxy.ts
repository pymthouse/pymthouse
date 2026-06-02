import { db } from "@/db/index";
import {
  appBillingOracleConfig,
  appUsers,
  developerApps,
  endUsers,
  oidcClients,
  signerConfig,
  streamSessions,
} from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  decodeOrchestratorInfo,
  calculateFeeWei,
  calculateLv2vPixels,
} from "./proto";
import type { AuthResult } from "./auth";
import { issueSignerDmzToken } from "./signer-dmz-token";
import { fetchSignerCliStatus, getSenderInfo } from "./signer-cli";
import { DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE } from "./signer-local-compose";
import { getIssuer } from "./oidc/issuer-urls";
import { getEthUsdOracle } from "./prices/eth-usd-oracle";
import {
  resolvePaymentPipelineModelConstraint,
  resolveGatewayAttribution,
  computeUsdMicrosFromWei,
} from "./billing-runtime";
import { signerSnapshotToIngestPayload } from "@pymthouse/builder-sdk";
import { ingestSignedTicketUsage } from "./billing/signed-ticket-ingest";
import {
  forwardToSigner as sdkForwardToSigner,
  normalizeSignerBaseUrl,
  pickConflictingNumberAliases,
  pickConflictingStringAliases,
  probeSignerHttpReachability as sdkProbeSignerHttpReachability,
  readSignerUpstreamBody,
  resolveSignerBaseUrl,
} from "@pymthouse/builder-sdk/signer/server";
import {
  parseSignerUsageSnapshot,
  stripSignerUsageFromResponse,
} from "./signer-usage-response";

export interface ProxyResult {
  status: number;
  body: unknown;
}

/**
 * Single shared clearinghouse signer (`id === "default"`).
 * Scale horizontally with multiple replicas behind one URL / load balancer — routing stays here.
 */
export async function getDefaultSigner() {
  const signerRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  return signerRows[0] ?? null;
}

/**
 * Resolve `developer_apps.id` from JWT/session `appId` (OIDC `client_id`).
 */
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

/**
 * Whether the clearinghouse signer can accept proxied signing traffic.
 * Uses DB status when already "running"; otherwise probes CLI (same path as Live Signer State).
 */
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

interface BillingOracleSelection {
  billingDisplayCurrency: string;
  billingOracleProviderKey: string;
}

async function resolveBillingOracleSelection(
  providerAppId: string | null,
): Promise<BillingOracleSelection> {
  if (!providerAppId) {
    return {
      billingDisplayCurrency: "USD",
      billingOracleProviderKey: "global_eth_usd",
    };
  }
  const rows = await db
    .select({
      billingDisplayCurrency: appBillingOracleConfig.billingDisplayCurrency,
      billingOracleProviderKey: appBillingOracleConfig.billingOracleProviderKey,
    })
    .from(appBillingOracleConfig)
    .where(eq(appBillingOracleConfig.clientId, providerAppId))
    .limit(1)
    .catch(() => []);
  const row = rows[0];
  return {
    billingDisplayCurrency: row?.billingDisplayCurrency ?? "USD",
    billingOracleProviderKey: row?.billingOracleProviderKey ?? "global_eth_usd",
  };
}

async function resolveUsageUserIdentifier(
  auth: AuthResult,
  providerAppId: string | null,
): Promise<string | null> {
  if (!providerAppId) return auth.userId || auth.endUserId || null;

  if (auth.endUserId) {
    const rows = await db
      .select({ externalUserId: endUsers.externalUserId })
      .from(endUsers)
      .where(and(eq(endUsers.id, auth.endUserId), eq(endUsers.appId, providerAppId)))
      .limit(1);
    return rows[0]?.externalUserId || auth.endUserId;
  }

  if (auth.userId) {
    const rows = await db
      .select({ externalUserId: appUsers.externalUserId })
      .from(appUsers)
      .where(and(eq(appUsers.id, auth.userId), eq(appUsers.clientId, providerAppId)))
      .limit(1);
    return rows[0]?.externalUserId || auth.userId;
  }

  return null;
}

/**
 * Base URL for the signer **HTTP** API (what `forwardToSigner` calls).
 *
 * With **signer-dmz**, this must be the **Apache** front (e.g. `http://localhost:8080`),
 * not go-livepeer’s in-container :8081. Prefer `SIGNER_INTERNAL_URL` so local
 * host/port overrides can repair stale DB rows without a migration.
 *
 * Always returned without a trailing slash so callers can safely concatenate
 * a leading-slash path (`${base}${path}`). A stored `http://host:8080/` would
 * otherwise produce `//sign-orchestrator-info`, which Go's ServeMux 301s to
 * the canonical path — undici follows the 301 as GET, and go-livepeer's
 * signer replies with `Method Not Allowed` on GET, surfacing as a 502 with
 * a "Unexpected token 'M'" JSON parse error in the proxy layer.
 */
/**
 * Public signer API base for external clients (gateway, SDK).
 * Routes through pymthouse `/api/signer/*` so usage is recorded in proxyGenerateLivePayment.
 */
export function getClientSignerApiUrl(): string {
  const explicit = process.env.PYMTHOUSE_CLIENT_SIGNER_API_URL?.trim();
  if (explicit) {
    return normalizeSignerBaseUrl(explicit);
  }
  const base =
    process.env.PYMTHOUSE_PUBLIC_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    "http://localhost:3001";
  return `${normalizeSignerBaseUrl(base)}/api/signer`;
}

export function getSignerUrl(signer?: typeof signerConfig.$inferSelect | null): string {
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

/** Stable `sub` for DMZ tokens used only by server-side signer health / sync probes. */
const SIGNER_SYNC_DMZ_SUBJECT = "pymthouse-signer-sync";

/**
 * Probe whether the signer HTTP front (Apache DMZ + go-livepeer) is reachable.
 * When /healthz responds, still requires GET /status to succeed (with DMZ JWT if
 * enabled, else unauthenticated): /healthz only proves Apache static config, not
 * that go-livepeer is answering behind the proxy.
 */
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

async function buildLivepeerIdentityHeaders(
  auth: AuthResult,
  providerAppId: string | null,
): Promise<Record<string, string> | null> {
  const clientId = auth.appId?.trim();
  const usageSubject = await resolveUsageUserIdentifier(auth, providerAppId);
  if (!clientId || !usageSubject) {
    return null;
  }
  return {
    "X-Livepeer-Usage-Issuer": getIssuer(),
    "X-Livepeer-Client-ID": clientId,
    "X-Livepeer-Usage-Subject": usageSubject,
    "X-Livepeer-Usage-Subject-Type": "external_user_id",
  };
}

async function forwardToSigner(
  signer: typeof signerConfig.$inferSelect | null | undefined,
  path: string,
  method: string,
  body: unknown | undefined,
  auth: AuthResult,
  providerAppId: string | null = auth.appId,
) {
  const sub = auth.endUserId || auth.userId || auth.appId || auth.sessionId;
  const identityHeaders = await buildLivepeerIdentityHeaders(auth, providerAppId);
  let outboundBody = body;
  if (
    identityHeaders &&
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body)
  ) {
    const record = body as Record<string, unknown>;
    outboundBody = {
      ...record,
      identity: {
        issuer: identityHeaders["X-Livepeer-Usage-Issuer"],
        client_id: identityHeaders["X-Livepeer-Client-ID"],
        usage_subject: identityHeaders["X-Livepeer-Usage-Subject"],
        usage_subject_type: identityHeaders["X-Livepeer-Usage-Subject-Type"],
      },
    };
  }
  return sdkForwardToSigner({
    baseUrl: getSignerUrl(signer),
    path,
    method,
    body: outboundBody,
    subject: sub,
    getDmzToken: getDmzTokenForSubject,
    forwardJwt: process.env.SIGNER_DMZ_FORWARD_JWT !== "false",
    extraHeaders: identityHeaders ?? undefined,
  });
}

/**
 * Decode the (unverified) claims of the DMZ JWT we just minted so we can log
 * what Apache saw when it rejected the request. We never print the
 * signature. `sub` is masked at the log layer to limit PII in server logs.
 */
function decodeUnverifiedJwtClaims(token: string | undefined): {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
} {
  if (!token) return {};
  const parts = token.split(".");
  if (parts.length < 2) return {};
  const decodePart = (segment: string): Record<string, unknown> | undefined => {
    try {
      const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
      return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return undefined;
    }
  };
  return { header: decodePart(parts[0]), payload: decodePart(parts[1]) };
}

/** Last four characters only, prefixed with … — enough for coarse log correlation without full identifiers. */
function maskJwtSubjectForLog(sub: unknown): { masked?: string; length?: number } {
  if (sub === undefined || sub === null) return {};
  const s = String(sub);
  if (s.length === 0) return {};
  return {
    length: s.length,
    masked: s.length <= 4 ? "****" : `…${s.slice(-4)}`,
  };
}

function formatDmzTokenForLog(authz: string | undefined) {
  const token = authz?.startsWith("Bearer ") ? authz.slice(7) : undefined;
  const { header, payload } = decodeUnverifiedJwtClaims(token);
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload?.exp === "number" ? payload.exp : undefined;
  const nbf = typeof payload?.nbf === "number" ? payload.nbf : undefined;
  const subLog = maskJwtSubjectForLog(payload?.sub);
  return {
    expected_issuer: getIssuer(),
    header_kid: header?.kid,
    header_alg: header?.alg,
    claim_iss: payload?.iss,
    claim_aud: payload?.aud,
    claim_sub_masked: subLog.masked,
    claim_sub_length: subLog.length,
    claim_scope: payload?.scope,
    claim_exp: exp,
    claim_nbf: nbf,
    now,
    exp_in_seconds: exp !== undefined ? exp - now : undefined,
    nbf_delta_seconds: nbf !== undefined ? nbf - now : undefined,
  };
}

/**
 * Proxy: POST /sign-orchestrator-info
 */
export async function proxySignOrchestratorInfo(
  requestBody: unknown,
  auth: AuthResult
): Promise<ProxyResult> {
  const { signer } = await getSignerRoutingContext(auth.appId);
  if (!signer || !(await isSignerOperational(signer))) {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  try {
    const { response, requestUrl, authorizationHeader } = await forwardToSigner(
      signer,
      "/sign-orchestrator-info",
      "POST",
      requestBody,
      auth,
    );
    const responseBody = await readSignerUpstreamBody(response);

    if (response.ok) {
      const who = auth.endUserId || auth.userId || "unknown";
      console.log(`[proxy] sign-orchestrator-info forwarded for ${who}`);
    } else if (response.status === 401 || response.status === 403) {
      const dmzContentType = response.headers.get("content-type") ?? null;
      const wwwAuthenticate = response.headers.get("www-authenticate") ?? null;
      console.error(
        `[proxy] sign-orchestrator-info signer DMZ ${response.status}`,
        {
          upstream_url: requestUrl,
          upstream_content_type: dmzContentType,
          upstream_www_authenticate: wwwAuthenticate,
          dmz_token: formatDmzTokenForLog(authorizationHeader),
          body_preview:
            typeof responseBody === "object" && responseBody !== null
              ? JSON.stringify(responseBody).slice(0, 500)
              : String(responseBody).slice(0, 500),
        },
      );
    }

    return { status: response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward sign-orchestrator-info:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}

/**
 * Proxy: POST /generate-live-payment
 * Tracks usage per end user when the token is scoped to one.
 */
export async function proxyGenerateLivePayment(
  requestBody: Record<string, unknown>,
  auth: AuthResult
): Promise<ProxyResult> {
  const { signer, providerAppId } = await getSignerRoutingContext(auth.appId);
  if (!signer || !(await isSignerOperational(signer))) {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  const manifestPick = pickConflictingStringAliases(
    requestBody,
    "manifestId",
    "ManifestID",
    "manifestID",
  );
  if (!manifestPick.ok) {
    return { status: 400, body: { error: manifestPick.message } };
  }
  const manifestId = manifestPick.value;

  const inPixelsPick = pickConflictingNumberAliases(
    requestBody,
    "inPixels",
    "InPixels",
  );
  if (!inPixelsPick.ok) {
    return { status: 400, body: { error: inPixelsPick.message } };
  }
  const inPixels = inPixelsPick.value;

  const preloadSecondsPick = pickConflictingNumberAliases(
    requestBody,
    "preloadSeconds",
    "PreloadSeconds",
  );
  if (!preloadSecondsPick.ok) {
    return { status: 400, body: { error: preloadSecondsPick.message } };
  }
  const preloadSeconds = preloadSecondsPick.value;

  const jobTypePick = pickConflictingStringAliases(requestBody, "type", "Type");
  if (!jobTypePick.ok) {
    return { status: 400, body: { error: jobTypePick.message } };
  }
  const jobType = jobTypePick.value;
  const normalizedJobType = jobType?.trim().toLowerCase();

  const orchPick = pickConflictingStringAliases(
    requestBody,
    "orchestrator",
    "Orchestrator",
  );
  if (!orchPick.ok) {
    return { status: 400, body: { error: orchPick.message } };
  }
  const orchestratorData = orchPick.value;

  let pricePerUnit = 0n;
  let pixelsPerUnit = 1n;
  let orchestratorAddress: string | undefined;

  if (orchestratorData) {
    try {
      const orchInfo = await decodeOrchestratorInfo(orchestratorData);
      if (orchInfo.priceInfo) {
        pricePerUnit = BigInt(orchInfo.priceInfo.pricePerUnit);
        pixelsPerUnit = BigInt(orchInfo.priceInfo.pixelsPerUnit || 1);
      }
      if (orchInfo.address) {
        orchestratorAddress =
          "0x" + Buffer.from(orchInfo.address).toString("hex");
      }
    } catch (err) {
      console.warn("[proxy] Failed to decode OrchestratorInfo:", err);
    }
  }

  let pixels: bigint;
  if (inPixels && inPixels > 0) {
    pixels = BigInt(inPixels);
  } else if (normalizedJobType === "lv2v") {
    pixels = calculateLv2vPixels(1);
  } else if (normalizedJobType === "byoc" && preloadSeconds && preloadSeconds > 0) {
    pixels = BigInt(Math.ceil(preloadSeconds));
  } else {
    pixels = 0n;
  }

  const feeWei = calculateFeeWei(pixels, pricePerUnit, pixelsPerUnit);
  const usageUserId = await resolveUsageUserIdentifier(auth, providerAppId);
  const billingOracleSelection = await resolveBillingOracleSelection(providerAppId);
  const nowIso = new Date().toISOString();
  let streamSessionId: string | null = null;

  // Upsert StreamSession, linked to end user if token is scoped
  if (manifestId) {
    const sessionRows = await db
      .select()
      .from(streamSessions)
      .where(
        and(
          eq(streamSessions.manifestId, manifestId),
          eq(streamSessions.status, "active"),
        ),
      )
      .limit(1);
    const existingSession = sessionRows[0];

    if (existingSession) {
      streamSessionId = existingSession.id;
    } else {
      const newSessionId = uuidv4();
      streamSessionId = newSessionId;
      await db.insert(streamSessions).values({
        id: newSessionId,
        endUserId: auth.endUserId || null,
        appId: providerAppId ?? auth.appId ?? null,
        bearerTokenHash: auth.tokenHash,
        manifestId,
        orchestratorAddress,
        signerPaymentCount: 0,
        totalFeeWei: "0",
        pricePerUnit: pricePerUnit.toString(),
        pixelsPerUnit: pixelsPerUnit.toString(),
        status: "active",
        lastPaymentAt: null,
      });
    }
  }

  const constraint = await resolvePaymentPipelineModelConstraint(requestBody);
  const attribution = resolveGatewayAttribution(requestBody);

  // Forward first — signing must not depend on NaaP pricing availability.
  try {
    const { response } = await forwardToSigner(
      signer,
      "/generate-live-payment",
      "POST",
      requestBody,
      auth,
      providerAppId,
    );
    const responseBody = await readSignerUpstreamBody(response);
    const usageSnapshot = parseSignerUsageSnapshot(responseBody);
    stripSignerUsageFromResponse(responseBody);

    if (response.ok) {
      const rawReq =
        (typeof requestBody.requestId === "string" && requestBody.requestId.trim()) ||
        (typeof requestBody.RequestID === "string" && requestBody.RequestID.trim());
      const requestId = usageSnapshot?.requestId || rawReq || uuidv4();

      const authoritativeFeeWei = usageSnapshot?.computedFeeWei
        ? BigInt(usageSnapshot.computedFeeWei)
        : feeWei;

      let networkFeeUsdMicros: bigint;
      let ethUsdPrice: string;
      let ethUsdObservedAt: string;

      if (usageSnapshot) {
        networkFeeUsdMicros = usageSnapshot.computedFeeUsdMicros;
        ethUsdPrice = usageSnapshot.ethUsdPrice ?? "0";
        ethUsdObservedAt =
          usageSnapshot.ethUsdObservedAt ?? new Date().toISOString();
      } else {
        const ethUsd = await getEthUsdOracle({
          appId: providerAppId,
          providerKey: billingOracleSelection.billingOracleProviderKey,
        });
        networkFeeUsdMicros = computeUsdMicrosFromWei(
          authoritativeFeeWei,
          ethUsd.priceUsd,
        );
        ethUsdPrice = ethUsd.priceUsd.toString();
        ethUsdObservedAt = ethUsd.observedAt;
      }

      const pipeline =
        usageSnapshot?.pipeline || constraint?.pipeline || undefined;
      const modelId =
        usageSnapshot?.modelId || constraint?.modelId || undefined;

      if (streamSessionId) {
        await db
          .update(streamSessions)
          .set({
            signerPaymentCount: sql`${streamSessions.signerPaymentCount} + 1`,
            totalFeeWei: sql`(${streamSessions.totalFeeWei}::numeric + ${authoritativeFeeWei.toString()}::numeric)::bigint::text`,
            lastPaymentAt: nowIso,
            pricePerUnit: pricePerUnit.toString(),
            pixelsPerUnit: pixelsPerUnit.toString(),
          })
          .where(eq(streamSessions.id, streamSessionId));
      }

      if (providerAppId && usageUserId && networkFeeUsdMicros > 0n) {
        try {
          const ticket = usageSnapshot
            ? {
                ...signerSnapshotToIngestPayload({
                  snapshot: usageSnapshot,
                  externalUserId: usageUserId,
                  gatewayRequestId: attribution.gatewayRequestId ?? undefined,
                }),
                requestId,
                feeWei: authoritativeFeeWei.toString(),
                pipeline,
                modelId,
                pixels: usageSnapshot.pixels ?? pixels.toString(),
                ethUsdPrice,
                ethUsdObservedAt,
              }
            : {
                requestId,
                externalUserId: usageUserId,
                networkFeeUsdMicros: networkFeeUsdMicros.toString(),
                feeWei: authoritativeFeeWei.toString(),
                pixels: pixels.toString(),
                pipeline,
                modelId,
                gatewayRequestId: attribution.gatewayRequestId ?? undefined,
                ethUsdPrice,
                ethUsdObservedAt,
              };
          await ingestSignedTicketUsage({
            clientId: providerAppId,
            ticket,
          });
        } catch (err) {
          console.warn("[proxy] usage ingest failed:", err);
        }
      }
    }

    return { status: response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward generate-live-payment:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}

/**
 * Proxy: POST /sign-byoc-job
 */
export async function proxySignByocJob(
  requestBody: unknown,
  auth: AuthResult
): Promise<ProxyResult> {
  const { signer } = await getSignerRoutingContext(auth.appId);
  if (!signer || !(await isSignerOperational(signer))) {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  try {
    const { response } = await forwardToSigner(
      signer,
      "/sign-byoc-job",
      "POST",
      requestBody,
      auth,
    );
    const responseBody = await readSignerUpstreamBody(response);

    if (response.ok) {
      const who = auth.endUserId || auth.userId || "unknown";
      console.log(`[proxy] sign-byoc-job forwarded for ${who}`);
    }

    return { status: response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward sign-byoc-job:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}

/**
 * Proxy: GET /discover-orchestrators
 */
export async function proxyDiscoverOrchestrators(
  auth: AuthResult
): Promise<ProxyResult> {
  const { signer } = await getSignerRoutingContext(auth.appId);
  if (!signer || !(await isSignerOperational(signer))) {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  try {
    const { response } = await forwardToSigner(
      signer,
      "/discover-orchestrators",
      "GET",
      undefined,
      auth,
    );
    const responseBody = await readSignerUpstreamBody(response);

    if (response.ok) {
      const who = auth.endUserId || auth.userId || "unknown";
      console.log(`[proxy] discover-orchestrators forwarded for ${who}`);
    }

    return { status: response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward discover-orchestrators:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}

/**
 * Sync signer status: HTTP DMZ probe, CLI live state (SIGNER_CLI_URL), and optional local Docker.
 * Remote signers often answer CLI while HTTP /status or sign-orchestrator probes fail; CLI is treated as live.
 */
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

  // Check Docker container state (local dev only; absent on Vercel)
  let containerRunning = false;
  let lastError: string | null = null;
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(
      `docker compose ps --format json ${DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE}`,
      { cwd: process.cwd(), timeout: 5000 }
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
            { cwd: process.cwd(), timeout: 5000 }
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
