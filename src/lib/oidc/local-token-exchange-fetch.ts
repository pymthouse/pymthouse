import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import {
  AppScopedSignerTokenExchangeError,
  handleAppScopedSignerTokenExchange,
} from "@/lib/oidc/app-scoped-signer-token-exchange";
import { timeSignerWebhookPhase } from "@/lib/oidc/signer-webhook-metrics";
import { getProviderApp } from "@/lib/provider-apps";

const APP_TOKEN_PATH = /^\/api\/v1\/apps\/([^/]+)\/oidc\/token$/;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  if (init?.body == null) return "";
  throw new TypeError(
    "local token exchange expects a string or URLSearchParams body",
  );
}

function clientCredentialsFromExchangeInit(
  form: URLSearchParams,
  init?: RequestInit,
): { clientId: string; clientSecret: string } {
  let clientId = form.get("client_id") || "";
  let clientSecret = form.get("client_secret") || "";
  const auth = new Headers(init?.headers).get("authorization") || "";
  if (!auth.startsWith("Basic ")) {
    return { clientId, clientSecret };
  }
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      return {
        clientId: decoded.slice(0, idx),
        clientSecret: decoded.slice(idx + 1),
      };
    }
  } catch {
    /* use form credentials */
  }
  return { clientId, clientSecret };
}

function writeExchangeAuditLog(
  publicClientId: string,
  status: string,
  correlationId: string,
): void {
  void (async () => {
    try {
      const app = await getProviderApp(publicClientId);
      await writeAuditLog({
        clientId: app?.id ?? null,
        action: "app_oidc_token_exchange",
        status,
        correlationId,
      });
    } catch (err) {
      console.error("[local-token-exchange] audit log failed:", err);
    }
  })();
}

async function exchangeInProcess(
  publicClientId: string,
  init?: RequestInit,
): Promise<Response> {
  const form = new URLSearchParams(requestBody(init));
  const { clientId, clientSecret } = clientCredentialsFromExchangeInit(form, init);
  const correlationId = createCorrelationId();

  try {
    const session = await handleAppScopedSignerTokenExchange({
      publicClientId,
      clientId,
      clientSecret,
      grantType: form.get("grant_type") || "",
      subjectToken: form.get("subject_token") || "",
      subjectTokenType: form.get("subject_token_type") || "",
      requestedTokenType: form.get("requested_token_type") || "",
      resource: form.get("resource") || "",
      audiences: form.getAll("audience"),
      correlationId,
    });
    writeExchangeAuditLog(publicClientId, "success", correlationId);
    return Response.json(session);
  } catch (err) {
    if (err instanceof AppScopedSignerTokenExchangeError) {
      writeExchangeAuditLog(publicClientId, err.code, correlationId);
      return Response.json(
        {
          error: err.code,
          error_description: err.message,
          correlation_id: correlationId,
        },
        { status: err.status },
      );
    }
    throw err;
  }
}

/**
 * Prefer an in-process token exchange when the exchange origin is this app.
 * Avoids a full public HTTPS round-trip (and a second lambda) back to self.
 */
export function createLocalTokenExchangeFetch(appOrigin: string): typeof fetch {
  let origin: string;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    return (input, init) =>
      timeSignerWebhookPhase("token_exchange", () => fetch(input, init));
  }

  return (input, init) =>
    timeSignerWebhookPhase("token_exchange", async () => {
      let parsed: URL;
      try {
        parsed = new URL(requestUrl(input));
      } catch {
        return fetch(input, init);
      }

      const match = APP_TOKEN_PATH.exec(parsed.pathname);
      const isLocalPost =
        parsed.origin === origin &&
        match != null &&
        (init?.method ?? "GET").toUpperCase() === "POST";
      if (!isLocalPost) {
        return fetch(input, init);
      }

      return exchangeInProcess(decodeURIComponent(match[1]!), init);
    });
}
