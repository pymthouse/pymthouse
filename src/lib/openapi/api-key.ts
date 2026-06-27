import { AppApiKeyBearerSchema } from "@/lib/openapi/schemas/credentials";

export class ApiKeyCredentialError extends Error {
  code: string;
  status: number;

  constructor(
    code: string,
    message: string,
    status = 400,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function parseAppApiKeyBearer(raw: string): string {
  const result = AppApiKeyBearerSchema.safeParse(raw);
  if (!result.success) {
    const message =
      result.error.issues[0]?.message ??
      "Invalid API key credential";
    throw new ApiKeyCredentialError("invalid_request", message, 400);
  }
  return result.data;
}

export function parseScopeList(
  scope: string | undefined,
  fallback = "sign:job",
): string[] {
  const requested = (scope ?? fallback)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return requested.length > 0 ? requested : [fallback];
}
