/**
 * Client IP extraction for abuse controls (rate limits).
 *
 * Forwarding headers are only trusted on Vercel (`VERCEL=1`), where the edge
 * sets peer identity. `cf-connecting-ip` is trusted only when that peer is a
 * Cloudflare published address (https://www.cloudflare.com/ips/).
 */

/** Cloudflare IPv4 ranges — https://www.cloudflare.com/ips-v4/ */
const CLOUDFLARE_IPV4_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;

/** Cloudflare IPv6 ranges — https://www.cloudflare.com/ips-v6/ */
const CLOUDFLARE_IPV6_CIDRS = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

type ParsedCidr = {
  network: bigint;
  mask: bigint;
};

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function parseIpv6ToBigInt(ip: string): bigint | null {
  let raw = ip.trim().toLowerCase();
  if (raw.startsWith("[") && raw.endsWith("]")) {
    raw = raw.slice(1, -1);
  }

  // IPv4-mapped IPv6 (:ffff:a.b.c.d) — expand the dotted quad.
  const v4Mapped = raw.match(/^(.+):(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Mapped) {
    const v4 = parseIpv4ToInt(v4Mapped[2]);
    if (v4 === null) return null;
    const hex =
      ((v4 >>> 16) & 0xffff).toString(16) +
      ":" +
      (v4 & 0xffff).toString(16);
    raw = `${v4Mapped[1]}:${hex}`;
  }

  const sides = raw.split("::");
  if (sides.length > 2) return null;

  const parseHeets = (s: string): number[] | null => {
    if (!s) return [];
    const parts = s.split(":");
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(Number.parseInt(p, 16));
    }
    return out;
  };

  let heets: number[];
  if (sides.length === 1) {
    const parsed = parseHeets(sides[0]);
    if (!parsed || parsed.length !== 8) return null;
    heets = parsed;
  } else {
    const left = parseHeets(sides[0]);
    const right = parseHeets(sides[1]);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    heets = [...left, ...Array(missing).fill(0), ...right];
  }

  let value = 0n;
  for (const h of heets) {
    value = (value << 16n) | BigInt(h);
  }
  return value;
}

function parseCidr(cidr: string, bits: 32 | 128): ParsedCidr | null {
  const [addr, prefixStr] = cidr.split("/");
  if (!addr || prefixStr === undefined) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;

  const network =
    bits === 32
      ? (() => {
          const v = parseIpv4ToInt(addr);
          return v === null ? null : BigInt(v);
        })()
      : parseIpv6ToBigInt(addr);
  if (network === null) return null;

  const width = BigInt(bits);
  const mask =
    prefix === 0
      ? 0n
      : ((1n << width) - 1n) ^ ((1n << (width - BigInt(prefix))) - 1n);

  return {
    network: network & mask,
    mask,
  };
}

const CF_V4 = CLOUDFLARE_IPV4_CIDRS.map((c) => parseCidr(c, 32)).filter(
  (c): c is ParsedCidr => c !== null,
);
const CF_V6 = CLOUDFLARE_IPV6_CIDRS.map((c) => parseCidr(c, 128)).filter(
  (c): c is ParsedCidr => c !== null,
);

function ipInCidrs(ip: string, cidrs: ParsedCidr[], bits: 32 | 128): boolean {
  const value =
    bits === 32
      ? (() => {
          const v = parseIpv4ToInt(ip);
          return v === null ? null : BigInt(v);
        })()
      : parseIpv6ToBigInt(ip);
  if (value === null) return false;
  return cidrs.some((c) => (value & c.mask) === c.network);
}

/** True when `ip` falls in Cloudflare's published edge ranges. */
export function isCloudflareIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return false;
  if (trimmed.includes(":")) {
    return ipInCidrs(trimmed, CF_V6, 128);
  }
  return ipInCidrs(trimmed, CF_V4, 32);
}

function rightmostHop(header: string | null): string | undefined {
  if (!header) return undefined;
  const hops = header
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.at(-1);
}

function platformPeerIp(request: Request): string | undefined {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const vercelForwarded = rightmostHop(
    request.headers.get("x-vercel-forwarded-for"),
  );
  if (vercelForwarded) return vercelForwarded;

  return rightmostHop(request.headers.get("x-forwarded-for"));
}

/**
 * Client IP for rate-limit keys. Spoofable headers are ignored unless running
 * on Vercel; `cf-connecting-ip` only when the platform peer is Cloudflare.
 */
export function clientIpFromRequest(request: Request): string {
  if (process.env.VERCEL !== "1") {
    return "unknown";
  }

  const peer = platformPeerIp(request);
  if (!peer) {
    return "unknown";
  }

  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf && isCloudflareIp(peer)) {
    return cf;
  }

  return peer;
}
