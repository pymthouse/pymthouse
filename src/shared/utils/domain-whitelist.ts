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
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end--;
  }
  if (end !== trimmed.length) {
    trimmed = trimmed.slice(0, end);
  }

  // Parse scheme and host:port
  let scheme: string | null = null;
  let hostPort: string;

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    hostPort = trimmed.slice(schemeMatch[0].length);
    // For full URLs, ignore path/query/fragment and keep only authority.
    const authorityEnd = hostPort.search(/[/?#]/);
    if (authorityEnd !== -1) {
      hostPort = hostPort.slice(0, authorityEnd);
    }
  } else {
    // No scheme provided - determine based on host
    hostPort = trimmed;
    // For host input without scheme, allow accidental path/query suffixes.
    const hostEnd = hostPort.search(/[/?#]/);
    if (hostEnd !== -1) {
      hostPort = hostPort.slice(0, hostEnd);
    }
  }

  // Parse host and port
  let host: string;
  let port: number | null = null;

  // IPv6 addresses in URLs are wrapped in brackets like [::1]
  const ipv6Match = hostPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    host = `[${ipv6Match[1]}]`;
    if (ipv6Match[2]) {
      port = parseInt(ipv6Match[2], 10);
    }
  } else {
    const lastColon = hostPort.lastIndexOf(":");
    if (lastColon !== -1 && hostPort.indexOf(":") === lastColon) {
      // Only one colon, likely host:port
      const possiblePort = hostPort.slice(lastColon + 1);
      if (/^\d+$/.test(possiblePort)) {
        host = hostPort.slice(0, lastColon);
        port = parseInt(possiblePort, 10);
      } else {
        host = hostPort;
      }
    } else {
      host = hostPort;
    }
  }

  if (!host) {
    return { success: false, error: "Invalid domain: no host found" };
  }

  host = host.toLowerCase();

  // Validate port
  if (port !== null) {
    if (port < 1 || port > 65535) {
      return { success: false, error: `Invalid port: ${port} (must be 1-65535)` };
    }
  }

  // Determine scheme if not provided
  if (!scheme) {
    scheme = isLocalhost(host.replace(/[\[\]]/g, "")) ? "http" : "https";
  }

  // Validate scheme
  if (scheme !== "http" && scheme !== "https") {
    return { success: false, error: `Unsupported scheme: ${scheme} (only http and https are allowed)` };
  }

  // http is only allowed for localhost
  if (scheme === "http" && !isLocalhost(host.replace(/[\[\]]/g, ""))) {
    return { success: false, error: "http scheme is only allowed for localhost, 127.0.0.1, and [::1]" };
  }

  // Normalize port: omit if it's the default for the scheme
  const defaultPort = getDefaultPort(scheme);
  if (port === defaultPort) {
    port = null;
  }

  // Build canonical origin
  const normalized = port !== null ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;

  return { success: true, normalized };
}
