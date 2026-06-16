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

const KONNECT_METER_QUERY_PATH_RE = /\/meters\/([^/]+)\/query$/;

async function buildKonnectRequest(request: Request): Promise<Request> {
  const sourceUrl = new URL(request.url);
  const rewritten = rewriteKonnectRequestUrl(sourceUrl, request.method);

  if (isKonnectMeterQueryGet(sourceUrl.pathname, request.method)) {
    const body = buildKonnectMeterQueryBody(sourceUrl.searchParams);
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    rewritten.search = "";

    const meterMatch = KONNECT_METER_QUERY_PATH_RE.exec(rewritten.pathname);
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

/**
 * Custom fetch wrapper handed to the OpenMeter SDK when routing to Kong Konnect.
 * It maps OpenMeter SDK requests/responses to the Konnect Metering & Billing v3
 * shapes, and constrains every outbound request to the configured metering
 * origin.
 *
 * SSRF note: the only data reaching `fetch` is the SDK-built request URL. This
 * wrapper rejects any origin other than the configured metering origin and then
 * rebuilds the outbound URL from that trusted origin, carrying over only the
 * already origin-checked path and query — so the destination host can never be
 * influenced by request input. Snyk Code still reports the path-level taint
 * (it does not model the env-configured origin allowlist as a sanitizer); the
 * finding is a reviewed false positive and this file is excluded from Snyk Code
 * in `.snyk` rather than weakening the host pinning. See `.snyk` for details.
 */
export function createKonnectFetch(allowedBaseUrl: string): typeof fetch {
  const allowedOrigin = new URL(allowedBaseUrl).origin;
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const konnectRequest = await buildKonnectRequest(request);

    const requested = new URL(konnectRequest.url);
    if (requested.origin !== allowedOrigin) {
      throw new Error("OpenMeter Konnect fetch blocked: unexpected origin");
    }
    const url = new URL(`${requested.pathname}${requested.search}`, allowedOrigin);

    const hasBody = konnectRequest.method !== "GET" && konnectRequest.method !== "HEAD";
    const response = await fetch(url, {
      method: konnectRequest.method,
      headers: konnectRequest.headers,
      body: hasBody ? await konnectRequest.arrayBuffer() : undefined,
      redirect: konnectRequest.redirect,
      signal: konnectRequest.signal,
      keepalive: konnectRequest.keepalive,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return response;
    }
    const body = await response.json();
    let normalized = normalizeKonnectResponseBody(body);
    if (isKonnectMeterQueryPath(url.pathname)) {
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
