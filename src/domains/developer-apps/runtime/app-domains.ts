import { listAppDomains, insertAppDomain, deleteAppDomain } from "../repo/app-domains";
import {
  domainDuplicateError,
  parseDomainCreateInput,
  parseDomainDeleteInput,
} from "../service/app-domains";

export async function readAppDomains(appId: string) {
  return listAppDomains(appId);
}

export async function createAppDomain(
  appId: string,
  body: unknown,
): Promise<
  | { ok: true; value: { id: string; domain: string } }
  | { ok: false; status: 400 | 409; error: string }
> {
  const parsed = parseDomainCreateInput(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  const existingDomains = await listAppDomains(appId);
  const isDuplicate = existingDomains.some(
    (d) => d.domain.toLowerCase() === parsed.value.domain.toLowerCase(),
  );
  if (isDuplicate) {
    return {
      ok: false,
      status: 409,
      error: domainDuplicateError(parsed.value.domain),
    };
  }

  try {
    const id = await insertAppDomain(appId, parsed.value.domain);
    return { ok: true, value: { id, domain: parsed.value.domain } };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      return {
        ok: false,
        status: 409,
        error: domainDuplicateError(parsed.value.domain),
      };
    }
    throw err;
  }
}

export async function removeAppDomain(
  appId: string,
  domainIdParam: string | null,
): Promise<{ ok: true } | { ok: false; status: 400; error: string }> {
  const parsed = parseDomainDeleteInput(domainIdParam);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  await deleteAppDomain(appId, parsed.value);
  return { ok: true };
}
