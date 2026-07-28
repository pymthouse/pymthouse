import { sanitizeUrl } from "@braintree/sanitize-url";

/** Returns a sanitized URL, or null for anything unsafe. */
export function toSafeLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return null;
  const safe = sanitizeUrl(trimmed);
  return safe === "about:blank" ? null : safe;
}
