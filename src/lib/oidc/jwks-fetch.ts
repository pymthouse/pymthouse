import * as jose from "jose";
import * as http from "node:http";
import * as https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

interface CachedJWKS {
  jwks: jose.JSONWebKeySet;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_ENTRIES = 128;
const cache = new Map<string, CachedJWKS>();

const MAX_REDIRECTS = 5;

/** Upper bound on JWKS HTTP response bodies to avoid unbounded memory use. */
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 1 * 1024 * 1024;

/** Result of JWKS URI safety checks; HTTP must use only `dnsRecords` as TCP targets. */
export interface SafeJwksResolution {
  url: URL;
  dnsRecords: { family: 4 | 6; address: string }[];
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) {
    return true;
  }

  const [a, b, c] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (/^fe[89ab]/.test(normalized)) {
    return true;
  }

  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8")
  ) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isPrivateOrReservedIpv4(mapped) : true;
  }

  return false;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateOrReservedIpv4(ip);
  if (family === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

function assertDnsRecordsSafe(
  records: { family: number; address: string }[],
): { family: 4 | 6; address: string }[] {
  const out: { family: 4 | 6; address: string }[] = [];
  for (const record of records) {
    if (record.family !== 4 && record.family !== 6) continue;
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error("JWKS URI resolves to a disallowed IP range");
    }
    out.push({ family: record.family, address: record.address });
  }
  return out;
}

/**
 * Parse and validate a JWKS URL, resolve the hostname to A/AAAA records, and
 * ensure every resolved address is a non-private IP. Callers must connect only
 * to addresses in `dnsRecords` while preserving `url` for Host / TLS SNI.
 */
export async function assertSafeJwksUri(jwksUri: string): Promise<SafeJwksResolution> {
  let parsed: URL;
  try {
    parsed = new URL(jwksUri);
  } catch {
    throw new Error("JWKS URI is not a valid URL");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("JWKS URI must use http or https");
  }

  if (process.env.NODE_ENV === "production" && protocol !== "https:") {
    throw new Error("JWKS URI must use https in production");
  }

  if (parsed.username || parsed.password) {
    throw new Error("JWKS URI must not include credentials");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("JWKS URI points to a disallowed host");
  }

  const ipKind = isIP(hostname);
  if (ipKind === 4 || ipKind === 6) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error("JWKS URI resolves to a disallowed IP range");
    }
    return {
      url: parsed,
      dnsRecords: [{ family: ipKind, address: hostname }],
    };
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error("JWKS URI host has no DNS records");
  }

  const dnsRecords = assertDnsRecordsSafe(records);
  if (dnsRecords.length === 0) {
    throw new Error("JWKS URI host has no usable DNS records");
  }

  return { url: parsed, dnsRecords };
}

async function readResponseBody(
  res: http.IncomingMessage,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      res.destroy();
      throw new Error("Response body too large");
    }
    chunks.push(buf);
    total += buf.length;
  }
  return Buffer.concat(chunks);
}

function requestOnceBound(
  target: SafeJwksResolution,
  record: { family: 4 | 6; address: string },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const { url } = target;
  const isHttps = url.protocol === "https:";
  const defaultPort = isHttps ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const path = `${url.pathname}${url.search}` || "/";
  const hostHeader = url.host || url.hostname;
  const tcpHost = record.family === 6 ? `[${record.address}]` : record.address;
  const sniHostname = isIP(url.hostname) === 0 ? url.hostname : undefined;

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        method: "GET",
        host: tcpHost,
        port,
        path,
        ...(isHttps && sniHostname ? { servername: sniHostname } : {}),
        headers: {
          Host: hostHeader,
          Accept: "application/json",
        },
        timeout: 10_000,
        ...(isHttps ? { rejectUnauthorized: true } : {}),
      },
      (res) => {
        void readResponseBody(res)
          .then((body) => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body,
            });
          })
          .catch(reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("JWKS request timed out"));
    });
    req.end();
  });
}

/**
 * HTTPS/HTTP GET using only validated `dnsRecords` as the TCP peer, with
 * Host and (for TLS) SNI taken from `target.url`.
 */
async function fetchJwksBoundToValidatedAddresses(
  target: SafeJwksResolution,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  let lastErr: Error | null = null;
  let lastHttp: { statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer } | null =
    null;

  for (const record of target.dnsRecords) {
    try {
      const res = await requestOnceBound(target, record);
      if (res.statusCode >= 200 && res.statusCode < 400) {
        return res;
      }
      lastHttp = res;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (lastHttp) {
    return lastHttp;
  }
  throw lastErr ?? new Error("JWKS fetch failed for all resolved addresses");
}

function isRedirectStatus(code: number): boolean {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

async function fetchJwksBodyFollowingRedirects(startUri: string): Promise<Buffer> {
  let current = startUri;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const target = await assertSafeJwksUri(current);
    const res = await fetchJwksBoundToValidatedAddresses(target);

    if (res.statusCode >= 200 && res.statusCode < 300) {
      return res.body;
    }

    if (isRedirectStatus(res.statusCode)) {
      const loc = res.headers.location;
      if (!loc || typeof loc !== "string") {
        throw new Error(`JWKS redirect from ${current} missing Location`);
      }
      current = new URL(loc, target.url).href;
      continue;
    }

    throw new Error(`Failed to fetch JWKS from ${current}: ${res.statusCode}`);
  }

  throw new Error(`JWKS fetch exceeded ${MAX_REDIRECTS} redirects`);
}

export async function fetchPlatformJWKS(jwksUri: string): Promise<jose.JSONWebKeySet> {
  const cached = cache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.jwks;
  }

  const bodyBuffer = await fetchJwksBodyFollowingRedirects(jwksUri);
  let body: jose.JSONWebKeySet;
  try {
    body = JSON.parse(bodyBuffer.toString("utf-8")) as jose.JSONWebKeySet;
  } catch {
    throw new Error(`Invalid JWKS JSON from ${jwksUri}`);
  }

  if (!body.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error(`Invalid JWKS from ${jwksUri}: no keys found`);
  }

  if (!cache.has(jwksUri) && cache.size >= CACHE_MAX_ENTRIES) {
    const oldestEntry = [...cache.entries()].sort(
      (a, b) => a[1].fetchedAt - b[1].fetchedAt,
    )[0];
    if (oldestEntry) {
      cache.delete(oldestEntry[0]);
    }
  }

  cache.set(jwksUri, { jwks: body, fetchedAt: Date.now() });
  return body;
}

export function invalidateJWKSCache(jwksUri: string): void {
  cache.delete(jwksUri);
}
