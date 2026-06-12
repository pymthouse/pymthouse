import { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl, isOpenMeterEnabled } from "./constants";
import { resolveKonnectMeterId } from "./konnect-catalog";
import {
  buildKonnectMeterQueryBody,
  isKonnectMeterQueryGet,
  isKonnectMeterQueryPath,
  normalizeKonnectMeterQueryResponse,
  normalizeKonnectResponseBody,
  rewriteKonnectRequestBody,
  rewriteKonnectRequestUrl,
} from "./konnect-routes";
import { resolveHostedOpenMeterBaseUrl, shouldUseKonnectRoutes } from "./route-mode";

let hostedClient: OpenMeter | null = null;

async function buildKonnectRequest(request: Request): Promise<Request> {
  const sourceUrl = new URL(request.url);
  const rewritten = rewriteKonnectRequestUrl(sourceUrl, request.method);

  if (isKonnectMeterQueryGet(sourceUrl.pathname, request.method)) {
    const body = buildKonnectMeterQueryBody(sourceUrl.searchParams);
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    rewritten.search = "";

    const meterMatch = rewritten.pathname.match(/\/meters\/([^/]+)\/query$/);
    if (meterMatch) {
      const meterId = await resolveKonnectMeterId(meterMatch[1]);
      rewritten.pathname = rewritten.pathname.replace(
        `/meters/${meterMatch[1]}/query`,
        `/meters/${meterId}/query`,
      );
    }

    return new Request(rewritten.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: request.redirect,
      signal: request.signal,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    contentType.includes("application/json")
  ) {
    const reqClone = request.clone();
    try {
      const json = await request.json();
      const body = rewriteKonnectRequestBody(rewritten.pathname, request.method, json);
      return new Request(rewritten.toString(), {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(body),
        redirect: request.redirect,
        signal: request.signal,
        credentials: request.credentials,
        integrity: request.integrity,
        keepalive: request.keepalive,
        mode: request.mode,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
      });
    } catch {
      return new Request(rewritten.toString(), reqClone);
    }
  }

  return new Request(rewritten.toString(), request);
}

function createKonnectFetch(): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const konnectRequest = await buildKonnectRequest(request);
    const response = await fetch(konnectRequest);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return response;
    }
    const body = await response.json();
    let normalized = normalizeKonnectResponseBody(body);
    if (isKonnectMeterQueryPath(new URL(konnectRequest.url).pathname)) {
      normalized = normalizeKonnectMeterQueryResponse(normalized);
    }
    if (normalized === body) {
      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function createOpenMeterClient(input: {
  baseUrl: string;
  apiKey?: string;
}): OpenMeter {
  const apiKey = input.apiKey?.trim() || undefined;
  const rawBaseUrl = input.baseUrl.replace(/\/$/, "");
  const useKonnectRoutes = shouldUseKonnectRoutes(rawBaseUrl, apiKey);
  const baseUrl = useKonnectRoutes ? resolveHostedOpenMeterBaseUrl(apiKey) : rawBaseUrl;
  const clientFetch = useKonnectRoutes ? createKonnectFetch() : undefined;

  if (apiKey) {
    return new OpenMeter({ baseUrl, apiKey, fetch: clientFetch });
  }
  return new OpenMeter({ baseUrl, fetch: clientFetch });
}

export function getHostedOpenMeterClient(): OpenMeter | null {
  if (!isOpenMeterEnabled()) {
    return null;
  }
  if (!hostedClient) {
    const apiKey = process.env.OPENMETER_API_KEY?.trim();
    hostedClient = createOpenMeterClient({
      baseUrl: getHostedOpenMeterUrl(),
      apiKey: apiKey || undefined,
    });
  }
  return hostedClient;
}

export function resetHostedOpenMeterClientForTests(): void {
  hostedClient = null;
}
