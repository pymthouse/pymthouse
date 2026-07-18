import { NextResponse } from "next/server";

/**
 * Machine-id rule for integrator-provisioned `externalUserId` values.
 * Emails are contact metadata only — never provisioned subject keys.
 * `owner:` / `user:` are transport markers, not create/path ids.
 */
export const INVALID_EXTERNAL_USER_ID = "invalid_external_user_id";

const MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL_LIKE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export class ExternalUserIdError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    code = INVALID_EXTERNAL_USER_ID,
    status = 400,
  ) {
    super(message);
    this.name = "ExternalUserIdError";
    this.code = code;
    this.status = status;
  }
}

export function isEmailShapedExternalUserId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes("@") || EMAIL_LIKE_RE.test(trimmed);
}

export function isValidExternalUserId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isEmailShapedExternalUserId(trimmed)) return false;
  if (trimmed.startsWith("owner:") || trimmed.startsWith("user:")) return false;
  return MACHINE_ID_RE.test(trimmed);
}

/**
 * Parse and validate an integrator-supplied external user id.
 * Throws {@link ExternalUserIdError} on empty / email / wire-prefix / charset.
 */
export function parseExternalUserId(raw: unknown): string {
  const id = String(raw ?? "").trim();
  if (!id) {
    throw new ExternalUserIdError("externalUserId is required");
  }
  if (isEmailShapedExternalUserId(id)) {
    throw new ExternalUserIdError(
      "externalUserId must be a machine id, not an email address",
    );
  }
  if (id.startsWith("owner:") || id.startsWith("user:")) {
    throw new ExternalUserIdError(
      "externalUserId must not use owner: or user: prefixes",
    );
  }
  if (!MACHINE_ID_RE.test(id)) {
    throw new ExternalUserIdError(
      "externalUserId must be 1–128 chars of [A-Za-z0-9._:-], starting with alphanumeric",
    );
  }
  return id;
}

export function invalidExternalUserIdResponse(
  err: ExternalUserIdError,
): NextResponse {
  return NextResponse.json(
    {
      error: err.code,
      error_description: err.message,
    },
    { status: err.status },
  );
}

/** Validate or return a 400 JSON response. */
export function requireExternalUserId(
  raw: unknown,
): { ok: true; externalUserId: string } | { ok: false; response: NextResponse } {
  try {
    return { ok: true, externalUserId: parseExternalUserId(raw) };
  } catch (err) {
    if (err instanceof ExternalUserIdError) {
      return { ok: false, response: invalidExternalUserIdResponse(err) };
    }
    throw err;
  }
}
