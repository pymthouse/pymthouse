/**
 * Domain whitelist normalization per RFC 6454 origin format.
 * 
 * Rules:
 * - Origin = scheme "://" host [":" port] (per RFC 6454 §7.1)
 * - Paths, query strings, fragments are stripped (not part of origin)
 * - Default scheme is https, unless host is localhost (then http allowed)
 * - http is ONLY allowed for localhost, 127.0.0.1, and [::1]
 * - Port is omitted if it matches the default for the scheme
 * - Input is trimmed and lowercased
 */

export interface NormalizationResult {
  success: true;
  normalized: string;
}

export interface NormalizationError {
  success: false;
  error: string;
}

type NormalizeResult = NormalizationResult | NormalizationError;

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

// Cap attacker-controlled input length before any pattern matching to eliminate
// ReDoS / polynomial-regex surface (OWASP ReDoS guidance, CWE-1333).
// A legitimate origin is scheme (8) + host (max 253 per RFC 1035) + port (6) +
// brackets/colons, so 512 is a generous upper bound.
const MAX_INPUT_LENGTH = 512;
const SLASH_CHAR_CODE = 47;

function isLocalhost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function getDefaultPort(scheme: string): number {
  return scheme === "http" ? DEFAULT_HTTP_PORT : DEFAULT_HTTPS_PORT;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end--;
  }
  return end !== value.length ? value.slice(0, end) : value;
}

function stripAuthoritySuffix(value: string): string {
  const end = value.search(/[/?#]/);
  return end !== -1 ? value.slice(0, end) : value;
}

function parseSchemeAndHostPort(trimmed: string): {
  scheme: string | null;
  hostPort: string;
} {
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    return {
      scheme: schemeMatch[1].toLowerCase(),
      hostPort: stripAuthoritySuffix(trimmed.slice(schemeMatch[0].length)),
    };
  }
  return {
    scheme: null,
    hostPort: stripAuthoritySuffix(trimmed),
  };
}

function parseHostAndPort(hostPort: string): {
  host: string;
  port: number | null;
} {
  const ipv6Match = hostPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    return {
      host: `[${ipv6Match[1]}]`,
      port: ipv6Match[2] ? parseInt(ipv6Match[2], 10) : null,
    };
  }

  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon !== -1 && hostPort.indexOf(":") === lastColon) {
    const possiblePort = hostPort.slice(lastColon + 1);
    if (/^\d+$/.test(possiblePort)) {
      return {
        host: hostPort.slice(0, lastColon),
        port: parseInt(possiblePort, 10),
      };
    }
  }

  return { host: hostPort, port: null };
}

function validateSchemeForHost(
  scheme: string,
  host: string,
): NormalizationError | null {
  if (scheme !== "http" && scheme !== "https") {
    return {
      success: false,
      error: `Unsupported scheme: ${scheme} (only http and https are allowed)`,
    };
  }
  if (scheme === "http" && !isLocalhost(host.replace(/[\[\]]/g, ""))) {
    return {
      success: false,
      error: "http scheme is only allowed for localhost, 127.0.0.1, and [::1]",
    };
  }
  return null;
}

function buildCanonicalOrigin(
  scheme: string,
  host: string,
  port: number | null,
): string {
  const defaultPort = getDefaultPort(scheme);
  const effectivePort = port === defaultPort ? null : port;
  return effectivePort !== null
    ? `${scheme}://${host}:${effectivePort}`
    : `${scheme}://${host}`;
}

export function normalizeDomainWhitelist(input: string): NormalizeResult {
  if (typeof input !== "string") {
    return { success: false, error: "Domain must be a string" };
  }

  let trimmed = input.trim();

  // Reject oversize input before running any regex-based parsing so that
  // attacker-controlled strings cannot trigger super-linear backtracking.
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { success: false, error: `Domain exceeds max length of ${MAX_INPUT_LENGTH} characters` };
  }

  if (!trimmed) {
    return { success: false, error: "Domain cannot be empty" };
  }

  // Strip trailing slashes without a regex (e.g. "example.com///").
  // Using a bounded index scan guarantees O(n) worst case and avoids the
  // polynomial-regex ReDoS surface flagged by CodeQL (js/polynomial-redos).
  trimmed = stripTrailingSlashes(trimmed);

  const { scheme: parsedScheme, hostPort } = parseSchemeAndHostPort(trimmed);
  let { host, port } = parseHostAndPort(hostPort);

  if (!host) {
    return { success: false, error: "Invalid domain: no host found" };
  }

  host = host.toLowerCase();

  if (port !== null && (port < 1 || port > 65535)) {
    return { success: false, error: `Invalid port: ${port} (must be 1-65535)` };
  }

  const scheme =
    parsedScheme ??
    (isLocalhost(host.replace(/[\[\]]/g, "")) ? "http" : "https");

  const schemeError = validateSchemeForHost(scheme, host);
  if (schemeError) return schemeError;

  return {
    success: true,
    normalized: buildCanonicalOrigin(scheme, host, port),
  };
}
