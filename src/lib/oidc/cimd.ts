/**
 * Client ID Metadata Document (CIMD) lookup for MCP public clients.
 *
 * Guards match Livepeer Console `lib/mcp/cimd.ts`. Unknown hosts, including
 * arbitrary GitHub gists, are refused. Cursor does not publish CIMD.
 */

import { normalizeRedirectUris } from "@/lib/oidc/mcp-dynamic-redirects";

const CHATGPT_CIMD_HOST = "chatgpt.com";
const CLAUDE_CIMD_HOSTS = new Set(["claude.ai", "claude.com"]);
const CLAUDE_CIMD_PATH = "/oauth/mcp-oauth-client-metadata";
const HERMES_CIMD_HOST = "nousresearch.github.io";
const HERMES_CIMD_PATH = "/hermes-agent/docs/oauth/client-metadata.json";
const CIMD_TIMEOUT_MS = 3000;
const CIMD_MAX_BYTES = 16_384;
const CIMD_CACHE_TTL_MS = 60_000;
const CIMD_CACHE_MAX_ENTRIES = 128;
const CIMD_MAX_CONCURRENT_FETCHES = 8;
const CIMD_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export type OAuthClient = {
  redirectUris: string[];
};

export type ResolveClientResult =
  | { ok: true; client: OAuthClient }
  | { ok: false; error: "invalid_client" | "temporarily_unavailable" };

type CacheEntry = {
  exp: number;
  client: OAuthClient;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ResolveClientResult>>();

export function clearCimdCache(): void {
  cache.clear();
}

/**
 * CIMD documents we fetch:
 *   https://claude.ai/oauth/mcp-oauth-client-metadata
 *   https://claude.com/oauth/mcp-oauth-client-metadata
 *   https://chatgpt.com/oauth/codex/client.json
 *   https://chatgpt.com/oauth/codex/<callback_id>/client.json
 *   https://chatgpt.com/oauth/<callback_id>/client.json
 *   https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json
 */
export function isAllowedCimdClientId(clientId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port) return false;
  if (parsed.search || parsed.hash) return false;
  if (parsed.href !== clientId) return false;
  if (CLAUDE_CIMD_HOSTS.has(parsed.hostname)) {
    return parsed.pathname === CLAUDE_CIMD_PATH;
  }
  if (parsed.hostname === HERMES_CIMD_HOST) {
    return parsed.pathname === HERMES_CIMD_PATH;
  }
  if (parsed.hostname !== CHATGPT_CIMD_HOST) return false;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return false;
  if (parts[0] !== "oauth") return false;
  if (parts.at(-1) !== "client.json") return false;
  const middle = parts.slice(1, -1);
  if (middle.length === 1) return CIMD_SEGMENT.test(middle[0] ?? "");
  return middle[0] === "codex" && CIMD_SEGMENT.test(middle[1] ?? "");
}

function supportsPublicClient(doc: Record<string, unknown>): boolean {
  const methods = doc.token_endpoint_auth_methods_supported;
  if (Array.isArray(methods)) {
    return methods.some((method) => String(method).toLowerCase() === "none");
  }
  const single = String(doc.token_endpoint_auth_method ?? "none").toLowerCase();
  return single === "none";
}

function parseCimdDocument(clientId: string, raw: unknown): OAuthClient | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.client_id !== clientId) return null;
  if (!supportsPublicClient(doc)) return null;
  const redirectUris = normalizeRedirectUris(doc.redirect_uris);
  if (!redirectUris) return null;
  return { redirectUris };
}

async function readLimitedJson(res: Response): Promise<object | null> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > CIMD_MAX_BYTES) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CIMD_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (size === 0) return null;

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as object;
  } catch {
    return null;
  }
}

function cacheClient(clientId: string, client: OAuthClient): void {
  if (cache.size >= CIMD_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(clientId, {
    exp: Date.now() + CIMD_CACHE_TTL_MS,
    client,
  });
}

async function fetchCimdClient(
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<ResolveClientResult> {
  let res: Response;
  try {
    res = await fetchImpl(clientId, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "temporarily_unavailable" };
  }

  if (res.status >= 500) {
    return { ok: false, error: "temporarily_unavailable" };
  }
  if (!res.ok) {
    return { ok: false, error: "invalid_client" };
  }

  let document: object | null;
  try {
    document = await readLimitedJson(res);
  } catch {
    return { ok: false, error: "temporarily_unavailable" };
  }
  const parsed = parseCimdDocument(clientId, document);
  if (!parsed) return { ok: false, error: "invalid_client" };
  cacheClient(clientId, parsed);
  return { ok: true, client: parsed };
}

export async function resolveCimdClient(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveClientResult> {
  if (!isAllowedCimdClientId(clientId)) {
    return { ok: false, error: "invalid_client" };
  }

  const hit = cache.get(clientId);
  if (hit && hit.exp > Date.now()) {
    return { ok: true, client: hit.client };
  }
  if (hit) cache.delete(clientId);

  const pending = inFlight.get(clientId);
  if (pending !== undefined) return pending;
  if (inFlight.size >= CIMD_MAX_CONCURRENT_FETCHES) {
    return { ok: false, error: "temporarily_unavailable" };
  }

  const request = fetchCimdClient(clientId, fetchImpl).finally(() => {
    inFlight.delete(clientId);
  });
  inFlight.set(clientId, request);
  return request;
}
