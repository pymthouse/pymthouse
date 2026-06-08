import { clearDiscoveryCache } from "@pymthouse/builder-sdk";
import type { SignedTicketIngestInput } from "@/lib/billing/types";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { resetGenerateLivePaymentHandlerForTests } from "@/lib/signer-direct-handler";
import {
  mockSignerFetch,
  type MockSignerController,
  type RecordedFetchCall,
} from "@/test-utils/mock-signer";

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function mockDirectSignerAccessToken(claims?: {
  clientId?: string;
  externalUserId?: string;
}): string {
  const issuer = getIssuer();
  const header = base64UrlJson({ alg: "none", typ: "JWT" });
  const payload = base64UrlJson({
    iss: issuer,
    client_id: claims?.clientId ?? "test-app-client",
    external_user_id: claims?.externalUserId ?? "test-external-user",
    sub: claims?.externalUserId ?? "test-external-user",
  });
  return `${header}.${payload}.mock-signature`;
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return "";
}

function parseJsonBody(raw: BodyInit | null | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface DirectSignerProxyMock extends MockSignerController {
  platformCalls: RecordedFetchCall[];
}

/**
 * Mock signer upstream plus in-process platform OIDC mint + signed-ticket ingest
 * for builder-sdk `createDirectSignerProxyHandler`.
 */
export function mockDirectSignerProxyFetch(
  opts?: Parameters<typeof mockSignerFetch>[0],
): DirectSignerProxyMock {
  clearDiscoveryCache(getIssuer());
  const originalFetch = globalThis.fetch;
  const signerMock = mockSignerFetch(opts);
  const signerFetch = globalThis.fetch;
  globalThis.fetch = originalFetch;

  const issuer = getIssuer();
  const issuerOrigin = new URL(issuer).origin;
  const platformCalls: RecordedFetchCall[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = resolveFetchUrl(input as RequestInfo | URL);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = parseJsonBody(
      init?.body ??
        (input instanceof Request && method !== "GET" ? await input.clone().text() : undefined),
    );

    if (url.includes("/.well-known/openid-configuration")) {
      platformCalls.push({ url, method, body });
      return new Response(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      url.startsWith(`${issuer}/token`) ||
      (url.startsWith(issuerOrigin) && url.includes("/token") && method === "POST")
    ) {
      platformCalls.push({ url, method, body });
      const form =
        typeof init?.body === "string"
          ? new URLSearchParams(init.body)
          : new URLSearchParams();
      const externalUserId = form.get("external_user_id")?.trim() || "test-external-user";
      return new Response(
        JSON.stringify({
          access_token: mockDirectSignerAccessToken({ externalUserId }),
          token_type: "Bearer",
          expires_in: 3600,
          balanceUsdMicros: "1000000000",
          lifetimeGrantedUsdMicros: "1000000000",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const ingestMatch = url.match(/\/api\/v1\/apps\/([^/]+)\/usage\/signed-tickets$/);
    if (ingestMatch && method === "POST") {
      platformCalls.push({ url, method, body });
      const clientId = decodeURIComponent(ingestMatch[1]!);
      const ticket = body as SignedTicketIngestInput;
      const { ingestSignedTicketUsage } = await import("@/lib/billing/signed-ticket-ingest");
      const result = await ingestSignedTicketUsage({ clientId, ticket });
      return new Response(
        JSON.stringify({
          clientId,
          requestId: ticket.requestId,
          ...result,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return signerFetch(input as never, init);
  }) as typeof fetch;

  return {
    ...signerMock,
    platformCalls,
    restore: () => {
      signerMock.restore();
    },
  };
}

export async function invokeGenerateLivePayment(
  token: string,
  requestBody: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  clearDiscoveryCache(getIssuer());
  resetGenerateLivePaymentHandlerForTests();
  const { POST } = await import("@/app/api/signer/generate-live-payment/route");
  const response = await POST(
    new Request("http://localhost/api/signer/generate-live-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    }) as never,
  );
  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}
