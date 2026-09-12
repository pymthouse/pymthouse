import { hasScope } from "@/domains/identity-access/runtime/request-auth";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; status: 400 | 401 | 403; body: Record<string, unknown> };

export function parseRequestedProgrammaticScopes(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["sign:job"];
  }
  const requestedScopes = String((body as Record<string, unknown>).scope || "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return requestedScopes.length > 0 ? requestedScopes : ["sign:job"];
}

export function validateProgrammaticTokenRequest(params: {
  authenticatedClient: { appId: string; scopes: string } | null;
  requestedClientId: string;
  correlationId: string;
}): Ok<true> | Err {
  if (!params.authenticatedClient) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "invalid_client",
        error_description: "failed confidential-client authentication",
        correlation_id: params.correlationId,
      },
    };
  }

  if (params.authenticatedClient.appId !== params.requestedClientId) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "forbidden",
        error_description: "client_id does not match the requested app",
        correlation_id: params.correlationId,
      },
    };
  }

  if (!hasScope(params.authenticatedClient.scopes, "users:token")) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "invalid_scope",
        error_description: "users:token scope is required for this client",
        correlation_id: params.correlationId,
      },
    };
  }

  return { ok: true, value: true };
}

export function validateProgrammaticScopes(params: {
  requestedScopes: string[];
  publicAllowedScopes: string;
  correlationId: string;
}): Ok<true> | Err {
  const invalidScope = params.requestedScopes.find(
    (scope) => !hasScope(params.publicAllowedScopes, scope) || scope === "admin",
  );
  if (!invalidScope) {
    return { ok: true, value: true };
  }

  return {
    ok: false,
    status: 400,
    body: {
      error: "invalid_scope",
      error_description: "requested scope is not allowed for this client",
      correlation_id: params.correlationId,
    },
  };
}
