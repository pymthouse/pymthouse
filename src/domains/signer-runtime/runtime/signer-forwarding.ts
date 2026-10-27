import type { AuthResult } from "@/domains/identity-access/runtime/request-auth";
import { issueSignerDmzToken } from "@/platform/signer/dmz-token";
import { formatDmzTokenForLog, getSignerUrl } from "./signer-status";

const httpDmzTokenCache = new Map<string, { token: string; expMs: number }>();
const HTTP_DMZ_TOKEN_MAX_ENTRIES = 100;
const HTTP_DMZ_TOKEN_TTL_MS = 3.5 * 60 * 1000;

export interface ProxyResult {
  status: number;
  body: unknown;
}

interface ForwardToSignerResult {
  response: Response;
  requestUrl: string;
  authorizationHeader?: string;
}

async function getHttpDmzBearerForSubject(subject: string): Promise<string> {
  const now = Date.now();
  const cached = httpDmzTokenCache.get(subject);
  if (cached && cached.expMs > now + 15_000) {
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

export async function forwardToSigner(params: {
  signer: { signerPort: number; signerUrl: string | null } | null | undefined;
  path: string;
  method: string;
  body: unknown | undefined;
  auth: AuthResult;
}): Promise<ForwardToSignerResult> {
  const url = `${getSignerUrl(params.signer)}${params.path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.SIGNER_DMZ_FORWARD_JWT !== "false") {
    const sub =
      params.auth.endUserId || params.auth.userId || params.auth.appId || params.auth.sessionId;
    const token = await getHttpDmzBearerForSubject(sub);
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      method: params.method,
      headers,
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
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

export async function readSignerUpstreamBody(response: Response): Promise<unknown> {
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

export function logSignerDmzFailure(params: {
  route: string;
  response: Response;
  requestUrl: string;
  authorizationHeader?: string;
  responseBody: unknown;
}) {
  if (params.response.status !== 401 && params.response.status !== 403) return;

  console.error(`[proxy] ${params.route} signer DMZ ${params.response.status}`, {
    upstream_url: params.requestUrl,
    upstream_content_type: params.response.headers.get("content-type") ?? null,
    upstream_www_authenticate: params.response.headers.get("www-authenticate") ?? null,
    dmz_token: formatDmzTokenForLog(params.authorizationHeader),
    body_preview:
      typeof params.responseBody === "object" && params.responseBody !== null
        ? JSON.stringify(params.responseBody).slice(0, 500)
        : String(params.responseBody).slice(0, 500),
  });
}
