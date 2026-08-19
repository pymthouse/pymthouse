import * as jose from "jose";
import * as http from "node:http";
import * as https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

interface CachedJWKS {
  jwks: jose.JSONWebKeySet;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 128;
const cache = new Map<string, CachedJWKS>();
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 1 * 1024 * 1024;

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
  if (normalized === "::" || normalized === "::1") return true;
  if (/^fe[89ab]/.test(normalized)) return true;
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
    return { url: parsed, dnsRecords: [{ family: ipKind, address: hostname }] };
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

async function fetchJwksWithRedirects(
  target: SafeJwksResolution,
  redirectsRemaining: number,
): Promise<jose.JSONWebKeySet> {
  const responses = await Promise.allSettled(
    target.dnsRecords.map((record) => requestOnceBound(target, record)),
  );
  const fulfilled = responses.find(
    (response): response is PromiseFulfilledResult<Awaited<ReturnType<typeof requestOnceBound>>> =>
      response.status === "fulfilled",
  );
  if (!fulfilled) {
    throw (responses[0] as PromiseRejectedResult).reason ?? new Error("JWKS request failed");
  }

  const { statusCode, headers, body } = fulfilled.value;
  if (statusCode >= 300 && statusCode < 400) {
    if (redirectsRemaining <= 0) {
      throw new Error("Too many JWKS redirects");
    }
    const location = headers.location;
    if (!location) {
      throw new Error("JWKS redirect missing location header");
    }
    const redirected = await assertSafeJwksUri(new URL(location, target.url).toString());
    return fetchJwksWithRedirects(redirected, redirectsRemaining - 1);
  }
  if (statusCode !== 200) {
    throw new Error(`JWKS request failed with status ${statusCode}`);
  }
  const parsed = JSON.parse(body.toString("utf8")) as jose.JSONWebKeySet;
  if (!parsed || !Array.isArray(parsed.keys)) {
    throw new Error("JWKS response is not a valid JWKS document");
  }
  return parsed;
}

export async function fetchPlatformJWKS(jwksUri: string): Promise<jose.JSONWebKeySet> {
  const cached = cache.get(jwksUri);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.jwks;
  }

  const target = await assertSafeJwksUri(jwksUri);
  const jwks = await fetchJwksWithRedirects(target, MAX_REDIRECTS);
  cache.set(jwksUri, { jwks, fetchedAt: now });

  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  return jwks;
}
