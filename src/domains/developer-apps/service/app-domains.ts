import { normalizeDomainWhitelist } from "@/shared/utils/domain-whitelist";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

export function parseDomainCreateInput(body: unknown): Ok<{ domain: string }> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "domain is required" };
  }

  const domain = (body as Record<string, unknown>).domain;
  if (!domain || typeof domain !== "string") {
    return { ok: false, error: "domain is required" };
  }

  const result = normalizeDomainWhitelist(domain);
  if (!result.success) {
    return { ok: false, error: result.error };
  }

  return { ok: true, value: { domain: result.normalized } };
}

export function parseDomainDeleteInput(domainId: string | null): Ok<string> | Err {
  if (!domainId) {
    return { ok: false, error: "domainId query parameter is required" };
  }
  return { ok: true, value: domainId };
}

export function domainDuplicateError(domain: string): string {
  return `Domain "${domain}" is already in the whitelist`;
}
