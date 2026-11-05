type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

export interface ParsedCreateAppUserInput {
  externalUserId: string;
  email: string | null;
  hasEmail: boolean;
  status: string;
  hasStatus: boolean;
}

export interface ParsedUpdateAppUserInput {
  externalUserId: string;
  email: string | null;
  hasEmail: boolean;
  status: string | null;
  hasStatus: boolean;
}

export function parseCreateAppUserInput(body: unknown): Ok<ParsedCreateAppUserInput> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "externalUserId is required" };
  }

  const externalUserId = String((body as Record<string, unknown>).externalUserId || "").trim();
  if (!externalUserId) {
    return { ok: false, error: "externalUserId is required" };
  }

  const hasEmail = typeof (body as Record<string, unknown>).email === "string";
  const hasStatus = typeof (body as Record<string, unknown>).status === "string";
  const email = hasEmail ? String((body as Record<string, unknown>).email).trim() : null;
  const status = hasStatus ? String((body as Record<string, unknown>).status) : "active";

  return {
    ok: true,
    value: { externalUserId, email, hasEmail, status, hasStatus },
  };
}

export function parseUpdateAppUserInput(body: unknown): Ok<ParsedUpdateAppUserInput> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "externalUserId is required" };
  }

  const externalUserId = String((body as Record<string, unknown>).externalUserId || "").trim();
  if (!externalUserId) {
    return { ok: false, error: "externalUserId is required" };
  }

  const hasEmail = typeof (body as Record<string, unknown>).email === "string";
  const hasStatus = typeof (body as Record<string, unknown>).status === "string";

  return {
    ok: true,
    value: {
      externalUserId,
      email: hasEmail ? String((body as Record<string, unknown>).email).trim() : null,
      hasEmail,
      status: hasStatus ? String((body as Record<string, unknown>).status) : null,
      hasStatus,
    },
  };
}

export function parseDeleteAppUserInput(externalUserId: string | null): Ok<string> | Err {
  if (!externalUserId) {
    return { ok: false, error: "externalUserId is required" };
  }

  return { ok: true, value: externalUserId };
}
