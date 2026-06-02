/**
 * Replace globalThis.fetch for the duration of a test so signer proxy routes
 * never hit the network. Any intercepted URL/body can be inspected via the
 * returned `calls` array. Non-signer URLs throw so we notice leaks.
 */

export interface RecordedFetchCall {
  url: string;
  method: string;
  body: unknown;
}

function synthesizeGenerateLivePaymentResponse(
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const requestId =
    (typeof requestBody.RequestID === "string" && requestBody.RequestID.trim()) ||
    (typeof requestBody.requestId === "string" && requestBody.requestId.trim()) ||
    "";
  const base: Record<string, unknown> = { payment: "mock-payment" };
  if (!requestId) {
    return base;
  }

  const inPixels =
    typeof requestBody.InPixels === "number" && Number.isFinite(requestBody.InPixels)
      ? Math.max(0, Math.trunc(requestBody.InPixels))
      : 0;
  const preloadSeconds =
    typeof requestBody.preloadSeconds === "number" &&
    Number.isFinite(requestBody.preloadSeconds)
      ? Math.max(0, Math.trunc(requestBody.preloadSeconds))
      : 0;

  const units = inPixels > 0 ? inPixels : preloadSeconds > 0 ? preloadSeconds : 1;
  const pricePerUnit = 1_000_000_000n;
  const pixelsPerUnit = 1n;
  const computedFeeWei = (BigInt(units) * pricePerUnit) / pixelsPerUnit;

  const ethUsd = Number(process.env.ETH_USD_PRICE ?? "3000");
  const ethUsdMicros = BigInt(Math.round(ethUsd * 1_000_000));
  const computedFeeUsdMicros = (computedFeeWei * ethUsdMicros) / 10n ** 18n;

  const usage: Record<string, unknown> = {
    request_id: requestId,
    computed_fee_wei: computedFeeWei.toString(),
    computed_fee_usd_micros: computedFeeUsdMicros.toString(),
    eth_usd_price: ethUsd.toString(),
    eth_usd_updated_at: new Date().toISOString(),
  };

  if (typeof requestBody.pipeline === "string" && requestBody.pipeline.trim()) {
    usage.pipeline = requestBody.pipeline.trim();
  }
  if (typeof requestBody.modelId === "string" && requestBody.modelId.trim()) {
    usage.model_id = requestBody.modelId.trim();
  }
  if (inPixels > 0) {
    usage.pixels = String(inPixels);
  }

  return { ...base, usage };
}

export interface MockSignerController {
  calls: RecordedFetchCall[];
  restore: () => void;
  /** Switch default success responses for a specific path to failure. */
  failNext: (path: string, status?: number) => void;
}

export function mockSignerFetch(opts?: {
  signerHost?: string;
  signOrchestratorInfoResponse?: unknown;
  signByocJobResponse?: unknown;
  discoverOrchestratorsResponse?: unknown;
  generateLivePaymentResponse?: unknown;
  dashboardPricingResponse?: unknown;
  pipelineCatalogResponse?: unknown;
}): MockSignerController {
  const signerHost = opts?.signerHost ?? "https://test-signer.invalid";
  const signerOrigin = new URL(signerHost).origin;
  const original = globalThis.fetch;

  const calls: RecordedFetchCall[] = [];
  const failures = new Map<string, number>();

  const pathDefaults: Record<string, unknown> = {
    "/sign-orchestrator-info":
      opts?.signOrchestratorInfoResponse ?? { signedData: "mock-signed" },
    "/sign-byoc-job":
      opts?.signByocJobResponse ?? { signedJob: "mock-signed" },
    "/discover-orchestrators":
      opts?.discoverOrchestratorsResponse ?? { orchestrators: [] },
    "/generate-live-payment":
      opts?.generateLivePaymentResponse ?? { payment: "mock-payment" },
  };

  const controller: MockSignerController = {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
    failNext: (path, status = 500) => {
      failures.set(path, status);
    },
  };

  const mocked: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: unknown = undefined;
    const rawBody = init?.body;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    calls.push({ url, method, body });

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(
        `mockSignerFetch: invalid URL in test: ${method} ${url}`,
      );
    }
    if (opts?.dashboardPricingResponse !== undefined && parsedUrl.pathname.endsWith("/dashboard/pricing")) {
      return new Response(JSON.stringify(opts.dashboardPricingResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (opts?.pipelineCatalogResponse !== undefined && parsedUrl.pathname.endsWith("/dashboard/pipeline-catalog")) {
      return new Response(JSON.stringify(opts.pipelineCatalogResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (parsedUrl.origin !== signerOrigin) {
      throw new Error(
        `mockSignerFetch: unexpected non-signer fetch in test: ${method} ${url}`,
      );
    }

    const path = parsedUrl.pathname;
    const failureStatus = failures.get(path);
    if (failureStatus) {
      failures.delete(path);
      return new Response(JSON.stringify({ error: "mock failure" }), {
        status: failureStatus,
        headers: { "Content-Type": "application/json" },
      });
    }

    let responseBody =
      pathDefaults[path] ?? { ok: true, echoed: { path, body } };

    if (
      path === "/generate-live-payment" &&
      opts?.generateLivePaymentResponse === undefined &&
      body !== null &&
      typeof body === "object"
    ) {
      responseBody = synthesizeGenerateLivePaymentResponse(body as Record<string, unknown>);
    }

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  globalThis.fetch = mocked as typeof fetch;

  return controller;
}
