import { db } from "@/db/index";
import {
  appUsers,
  developerApps,
  endUsers,
  oidcClients,
  planCapabilityBundles,
  plans,
  signerConfig,
  streamSessions,
  transactions,
  usageBillingEvents,
  usageRecords,
} from "@/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  decodeOrchestratorInfo,
  calculateFeeWei,
  calculatePlatformCut,
  calculateLv2vPixels,
} from "./proto";
import type { AuthResult } from "./auth";
import { issueSignerDmzToken } from "./signer-dmz-token";
import { getSenderInfo } from "./signer-cli";
import { DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE } from "./signer-local-compose";
import { getIssuer } from "./oidc/issuer-urls";
import { getEthUsdOracle } from "./prices/eth-usd-oracle";
import {
  resolvePaymentPipelineModelConstraint,
  resolveGatewayAttribution,
  buildSignedTicketConstraintHash,
  resolveUpcharge,
  computeUsdMicrosFromWei,
  weiToEthString,
} from "./billing-runtime";

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
 * not go-livepeer’s in-container :8081. Use `SIGNER_INTERNAL_URL` or `signer_url`
 * when the DB `signer_port` still says 8081 from an old bare-signer row.
 *
 * Always returned without a trailing slash so callers can safely concatenate
 * a leading-slash path (`${base}${path}`). A stored `http://host:8080/` would
 * otherwise produce `//sign-orchestrator-info`, which Go's ServeMux 301s to
 * the canonical path — undici follows the 301 as GET, and go-livepeer's
 * signer replies with `Method Not Allowed` on GET, surfacing as a 502 with
 * a "Unexpected token 'M'" JSON parse error in the proxy layer.
 */
export function getSignerUrl(signer?: typeof signerConfig.$inferSelect | null): string {
  const testSignerUrl =
    process.env.NODE_ENV === "test"
      ? process.env.PYMTHOUSE_TEST_SIGNER_URL
      : undefined;
  if (testSignerUrl && testSignerUrl.trim() !== "") {
    return testSignerUrl.replace(/\/+$/, "");
  }

  // 127.0.0.1 (not "localhost"): the docker-compose publish is bound to 127.0.0.1
  // only, and some hosts resolve "localhost" to an IPv6 or LAN IPv4 address via
  // nsswitch/mDNS, producing ECONNREFUSED even when the container is healthy.
  //
  // Legacy rows had signer_port=8081 (bare go-livepeer HTTP). That's now the
  // in-container port; publicly we hit Apache on 8080. Coerce so an un-upgraded
  // row still lands on the DMZ listener.
  const LEGACY_BARE_SIGNER_PORT = 8081;
  const rawPort = signer?.signerPort ?? 8080;
  const port = rawPort === LEGACY_BARE_SIGNER_PORT ? 8080 : rawPort;
  const base =
    signer?.signerUrl
    || process.env.SIGNER_INTERNAL_URL
    || `http://127.0.0.1:${port}`;
  return base.replace(/\/+$/, "");
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
  const timeoutMs = 5000;
  let ethAddress: string | undefined;

  const parseEthFromStatus = async (
    response: Response,
  ): Promise<string | undefined> => {
    if (!response.ok) return undefined;
    const data = (await readSignerUpstreamBody(response)) as Record<
      string,
      unknown
    >;
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
          const { ok, addr } = await fetchStatus({
            Authorization: `Bearer ${token}`,
          });
          if (ok) {
            return { reachable: true, ethAddress: addr };
          }
        } catch {
          /* continue */
        }
      }
      try {
        const { ok, addr } = await fetchStatus({});
        if (ok) {
          return { reachable: true, ethAddress: addr };
        }
      } catch {
        /* continue */
      }
      return { reachable: false, ethAddress: undefined };
    }
  } catch {
    /* try /status without healthz */
  }

  if (process.env.SIGNER_DMZ_FORWARD_JWT !== "false") {
    try {
      const token = await issueSignerDmzToken({
        gate: "http",
        subject: SIGNER_SYNC_DMZ_SUBJECT,
      });
      const { ok, addr } = await fetchStatus({
        Authorization: `Bearer ${token}`,
      });
      if (ok) {
        return { reachable: true, ethAddress: addr };
      }
    } catch {
      /* continue */
    }
  }

  try {
    const { ok, addr } = await fetchStatus({});
    if (ok) {
      return { reachable: true, ethAddress: addr };
    }
  } catch {
    /* unreachable */
  }

  return { reachable: false, ethAddress: undefined };
}

/**
 * Per-subject LRU cache for DMZ bearer tokens. Mirrors the scheme in `signer-cli.ts`:
 * DMZ tokens are minted for ~4 minutes; we serve cached copies for ~3.5 minutes and
 * mint a fresh one slightly before expiry so in-flight Apache verification never
 * trips the clock skew / leeway window.
 *
 * Keyed by the subject we put in the JWT (`sub` claim), so two callers acting on
 * behalf of the same principal reuse the same token instead of minting one per request.
 */
const HTTP_DMZ_TOKEN_MAX_ENTRIES = 100;
const HTTP_DMZ_TOKEN_TTL_MS = 3.5 * 60 * 1000;
const httpDmzTokenCache = new Map<string, { token: string; expMs: number }>();

async function getHttpDmzBearerForSubject(subject: string): Promise<string> {
  const now = Date.now();
  const cached = httpDmzTokenCache.get(subject);
  if (cached && cached.expMs > now + 15_000) {
    // Bump recency: re-insertion moves the entry to the end of the Map iteration order.
    httpDmzTokenCache.delete(subject);
    httpDmzTokenCache.set(subject, cached);
    return cached.token;
  }

  const token = await issueSignerDmzToken({ gate: "http", subject });
  httpDmzTokenCache.set(subject, { token, expMs: now + HTTP_DMZ_TOKEN_TTL_MS });

  if (httpDmzTokenCache.size > HTTP_DMZ_TOKEN_MAX_ENTRIES) {
    const oldest = httpDmzTokenCache.keys().next().value;
    if (oldest !== undefined) httpDmzTokenCache.delete(oldest);
  }

  return token;
}

interface ForwardToSignerResult {
  response: Response;
  requestUrl: string;
  authorizationHeader?: string;
}

async function forwardToSigner(
  signer: typeof signerConfig.$inferSelect | null | undefined,
  path: string,
  method: string,
  body: unknown | undefined,
  auth: AuthResult,
): Promise<ForwardToSignerResult> {
  const url = `${getSignerUrl(signer)}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.SIGNER_DMZ_FORWARD_JWT !== "false") {
    // Fall back to sessionId (always populated on AuthResult) so unauthenticated-but-
    // session-scoped callers don't collapse onto a single shared "signer-proxy" token —
    // each session keeps its own cache entry and stays traceable in upstream logs.
    const sub =
      auth.endUserId || auth.userId || auth.appId || auth.sessionId;
    const token = await getHttpDmzBearerForSubject(sub);
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return {
      response,
      requestUrl: url,
      authorizationHeader: headers.Authorization,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Apache may return HTML on 401; avoid throwing so callers surface real status. */
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

function pickConflictingStringAliases(
  body: Record<string, unknown>,
  ...keys: string[]
):
  | { ok: true; value: string | undefined }
  | { ok: false; message: string } {
  const values = keys
    .map((key) => {
      const raw = body[key];
      const defined = raw !== undefined && raw !== null && `${raw}`.length > 0;
      return defined ? { key, value: String(raw) } : null;
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null);
  const first = values[0];
  const conflict = values.find((entry) => entry.value !== first?.value);
  if (first && conflict) {
    return {
      ok: false,
      message: `Conflicting ${keys.join("/")} in request body`,
    };
  }
  return { ok: true, value: first?.value };
}

function pickConflictingNumberAliases(
  body: Record<string, unknown>,
  ...keys: string[]
):
  | { ok: true; value: number | undefined }
  | { ok: false; message: string } {
  const parseNum = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };
  const values = keys
    .map((key) => {
      const value = parseNum(body[key]);
      return value !== undefined ? { key, value } : null;
    })
    .filter((entry): entry is { key: string; value: number } => entry !== null);
  const first = values[0];
  const conflict = values.find((entry) => entry.value !== first?.value);
  if (first && conflict) {
    return {
      ok: false,
      message: `Conflicting ${keys.join("/")} in request body`,
    };
  }
  return { ok: true, value: first?.value };
}

/**
 * Proxy: POST /sign-orchestrator-info
 */
export async function proxySignOrchestratorInfo(
  requestBody: unknown,
  auth: AuthResult
): Promise<ProxyResult> {
  const { signer } = await getSignerRoutingContext(auth.appId);
  if (!signer || signer.status !== "running") {
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
  if (!signer || signer.status !== "running") {
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
  const platformCutWei = calculatePlatformCut(
    feeWei,
    signer.defaultCutPercent
  );
  const usageUserId = await resolveUsageUserIdentifier(auth, providerAppId);
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
    );
    const responseBody = await readSignerUpstreamBody(response);

    if (response.ok) {
      const orchAddrForConstraint =
        orchestratorAddress && orchestratorAddress.length > 0
          ? orchestratorAddress
          : "0x";

      const signedPriceStr = pricePerUnit.toString();
      const signedPixelsStr = pixelsPerUnit.toString();
      const pipelineModelConstraintHash =
        constraint !== null
          ? buildSignedTicketConstraintHash({
              pipeline: constraint.pipeline,
              modelId: constraint.modelId,
              orchAddress: orchAddrForConstraint,
              signedPriceWeiPerUnit: signedPriceStr,
              signedPixelsPerUnit: signedPixelsStr,
            })
          : null;

      let priceValidationStatus: string;
      let priceValidationReason: string | undefined;
      if (!constraint) {
        priceValidationStatus = "missing_constraint";
        priceValidationReason =
          "No pipeline/model in request (add pipeline and modelId or capabilities with PerCapability models) for full attribution.";
      } else {
        priceValidationStatus = "matched";
      }

      // Dedupe is per explicit RequestID only. Do NOT fall back to manifestId — the gateway
      // keeps one manifest for the whole LV2V session, so that would collapse every payment
      // into a single usage row and freeze signerPaymentCount at 1.
      const rawReq =
        (typeof requestBody.requestId === "string" && requestBody.requestId.trim()) ||
        (typeof requestBody.RequestID === "string" && requestBody.RequestID.trim());
      const requestId = rawReq || uuidv4();

      // Check for an existing usage record first to prevent duplicate inserts on retries
      let existingUsage = null;
      if (providerAppId) {
        const usageRows = await db
          .select()
          .from(usageRecords)
          .where(
            and(
              eq(usageRecords.clientId, providerAppId),
              eq(usageRecords.requestId, requestId),
            ),
          )
          .limit(1);
        existingUsage = usageRows[0] ?? null;
      }

      if (!existingUsage) {
        // Fetch ETH/USD oracle at signing time
        const ethUsd = await getEthUsdOracle();

        // Compute USD values from wei
        const networkFeeUsdMicros = computeUsdMicrosFromWei(feeWei, ethUsd.priceUsd);
        const ownerChargeWei = feeWei + platformCutWei;
        const ownerPlatformFeeUsdMicros = computeUsdMicrosFromWei(platformCutWei, ethUsd.priceUsd);
        const ownerChargeUsdMicros = computeUsdMicrosFromWei(ownerChargeWei, ethUsd.priceUsd);

        // Resolve plan upcharge when we have a pipeline/model constraint.
        let upchargeResult: {
          bps: number;
          source: "pipeline_model" | "general" | "pay_per_use" | "subscription_included" | "unpriced";
        } = { bps: 0, source: "unpriced" as const };
        if (providerAppId && constraint) {
          try {
            const planRows = await db
              .select()
              .from(plans)
              .where(and(eq(plans.clientId, providerAppId), eq(plans.status, "active")))
              .orderBy(desc(plans.updatedAt))
              .limit(1);
            const bundleRows = planRows[0]
              ? await db
                  .select()
                  .from(planCapabilityBundles)
                  .where(
                    and(
                      eq(planCapabilityBundles.planId, planRows[0].id),
                      eq(planCapabilityBundles.clientId, providerAppId),
                    ),
                  )
              : [];
            upchargeResult = resolveUpcharge({
              plan: planRows[0] ?? null,
              bundles: bundleRows,
              pipeline: constraint.pipeline,
              modelId: constraint.modelId,
            });
          } catch (err) {
            console.warn("[proxy] Plan upcharge lookup failed:", err);
          }
        }

        // Compute end-user billable: networkFee * (1 + upchargeBps/10000) in micros
        const endUserBillableUsdMicros =
          upchargeResult.bps > 0
            ? networkFeeUsdMicros + (networkFeeUsdMicros * BigInt(upchargeResult.bps)) / 10000n
            : networkFeeUsdMicros;

        const transactionId = uuidv4();
        const usageRecordId = uuidv4();

        await db.transaction(async (tx) => {
          if (streamSessionId) {
            await tx
              .update(streamSessions)
              .set({
                signerPaymentCount: sql`${streamSessions.signerPaymentCount} + 1`,
                totalFeeWei: sql`(${streamSessions.totalFeeWei}::numeric + ${feeWei.toString()}::numeric)::bigint::text`,
                lastPaymentAt: nowIso,
                pricePerUnit: pricePerUnit.toString(),
                pixelsPerUnit: pixelsPerUnit.toString(),
              })
              .where(eq(streamSessions.id, streamSessionId));
          }

          await tx.insert(transactions).values({
            id: transactionId,
            endUserId: auth.endUserId || null,
            appId: providerAppId ?? auth.appId ?? null,
            clientId: providerAppId,
            streamSessionId,
            type: "usage",
            amountWei: feeWei.toString(),
            platformCutPercent: signer.defaultCutPercent,
            platformCutWei: platformCutWei.toString(),
            status: "confirmed",
            pipeline: constraint?.pipeline ?? null,
            modelId: constraint?.modelId ?? null,
            attributionSource: attribution.attributionSource,
            gatewayRequestId: attribution.gatewayRequestId,
            paymentMetadataVersion: attribution.paymentMetadataVersion,
            pipelineModelConstraintHash,
            advertisedPriceWeiPerUnit: constraint ? signedPriceStr : null,
            advertisedPixelsPerUnit: constraint ? signedPixelsStr : null,
            signedPriceWeiPerUnit: pricePerUnit.toString(),
            signedPixelsPerUnit: pixelsPerUnit.toString(),
            priceValidationStatus,
            priceValidationReason: priceValidationReason ?? null,
            // ETH/USD oracle snapshot
            ethUsdPrice: ethUsd.priceUsd.toString(),
            ethUsdSource: ethUsd.source,
            ethUsdObservedAt: ethUsd.observedAt,
            networkFeeUsdMicros: networkFeeUsdMicros.toString(),
            ownerPlatformFeeWei: platformCutWei.toString(),
            ownerPlatformFeeUsdMicros: ownerPlatformFeeUsdMicros.toString(),
            ownerChargeWei: ownerChargeWei.toString(),
            ownerChargeUsdMicros: ownerChargeUsdMicros.toString(),
          });

          if (providerAppId) {
            const clientId = providerAppId;
            await tx.insert(usageRecords).values({
              id: usageRecordId,
              requestId,
              userId: usageUserId,
              clientId,
              modelId: constraint?.modelId ?? null,
              units: pixels.toString(),
              fee: feeWei.toString(),
              createdAt: new Date().toISOString(),
            });

            // Billable ledger row when pipeline/model constraint is present (negotiated ticket).
            if (constraint && pipelineModelConstraintHash) {
              await tx.insert(usageBillingEvents).values({
                id: uuidv4(),
                usageRecordId,
                transactionId,
                streamSessionId,
                clientId,
                userId: usageUserId,
                pipeline: constraint.pipeline,
                modelId: constraint.modelId,
                attributionSource: attribution.attributionSource,
                gatewayRequestId: attribution.gatewayRequestId,
                paymentMetadataVersion: attribution.paymentMetadataVersion,
                pipelineModelConstraintHash: pipelineModelConstraintHash,
                orchAddress: orchestratorAddress ?? null,
                advertisedPriceWeiPerUnit: signedPriceStr,
                advertisedPixelsPerUnit: signedPixelsStr,
                signedPriceWeiPerUnit: pricePerUnit.toString(),
                signedPixelsPerUnit: pixelsPerUnit.toString(),
                networkFeeWei: feeWei.toString(),
                networkFeeUsdMicros: networkFeeUsdMicros.toString(),
                platformFeeWei: platformCutWei.toString(),
                platformFeeUsdMicros: ownerPlatformFeeUsdMicros.toString(),
                ownerChargeWei: ownerChargeWei.toString(),
                ownerChargeUsdMicros: ownerChargeUsdMicros.toString(),
                upchargePercentBps: upchargeResult.bps,
                pricingRuleSource: upchargeResult.source,
                endUserBillableUsdMicros: endUserBillableUsdMicros.toString(),
                ethUsdPrice: ethUsd.priceUsd.toString(),
                ethUsdSource: ethUsd.source,
                ethUsdObservedAt: ethUsd.observedAt,
                createdAt: new Date().toISOString(),
              });
            }
          }
        });
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
  if (!signer || signer.status !== "running") {
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
  if (!signer || signer.status !== "running") {
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
 * Sync signer status by checking both the Docker container and the HTTP endpoint.
 */
export async function syncSignerStatus(): Promise<{
  reachable: boolean;
  ethAddress?: string;
  containerRunning?: boolean;
}> {
  // HTTP reachability: /healthz + /status (with server DMZ JWT, same as proxy traffic)
  let reachable = false;
  let ethAddress: string | undefined;

  try {
    const defaultSigner = await getDefaultSigner();
    const probe = await probeSignerHttpReachability(getSignerUrl(defaultSigner));
    reachable = probe.reachable;
    ethAddress = probe.ethAddress;
  } catch {}

  // Check Docker container state
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
        // Grab last few log lines for the error
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

  // Determine status
  let status: string;
  if (reachable) {
    status = "running";
    lastError = null;
  } else if (containerRunning) {
    status = "running"; // container up but HTTP not ready yet
  } else {
    status = "stopped";
  }

  // Fetch deposit/reserve from CLI port (same data livepeer_cli reads).
  // Best-effort: only updates if the CLI is reachable.
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

  await db
    .update(signerConfig)
    .set(dbSet)
    .where(eq(signerConfig.id, "default"));

  return { reachable, ethAddress, containerRunning };
}
