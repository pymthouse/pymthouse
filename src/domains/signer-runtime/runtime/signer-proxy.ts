import type { AuthResult } from "@/domains/identity-access/runtime/request-auth";
import { forwardToSigner, logSignerDmzFailure, readSignerUpstreamBody, type ProxyResult } from "./signer-forwarding";
import { getSignerRoutingContext } from "./signer-routing";

export async function proxySignOrchestratorInfo(
  requestBody: unknown,
  auth: AuthResult,
): Promise<ProxyResult> {
  const { signer } = await getSignerRoutingContext(auth.appId);
  if (!signer || signer.status !== "running") {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  try {
    const result = await forwardToSigner({
      signer,
      path: "/sign-orchestrator-info",
      method: "POST",
      body: requestBody,
      auth,
    });
    const responseBody = await readSignerUpstreamBody(result.response);

    if (result.response.ok) {
      const who = auth.endUserId || auth.userId || "unknown";
      console.log(`[proxy] sign-orchestrator-info forwarded for ${who}`);
    } else {
      logSignerDmzFailure({
        route: "sign-orchestrator-info",
        response: result.response,
        requestUrl: result.requestUrl,
        authorizationHeader: result.authorizationHeader,
        responseBody,
      });
    }

    return { status: result.response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward sign-orchestrator-info:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}

export async function proxySignByocJob(
  requestBody: unknown,
  auth: AuthResult,
): Promise<ProxyResult> {
  const { signer } = await getSignerRoutingContext(auth.appId);
  if (!signer || signer.status !== "running") {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  try {
    const result = await forwardToSigner({
      signer,
      path: "/sign-byoc-job",
      method: "POST",
      body: requestBody,
      auth,
    });
    const responseBody = await readSignerUpstreamBody(result.response);

    if (result.response.ok) {
      const who = auth.endUserId || auth.userId || "unknown";
      console.log(`[proxy] sign-byoc-job forwarded for ${who}`);
    }

    return { status: result.response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward sign-byoc-job:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}

export async function proxyDiscoverOrchestrators(auth: AuthResult): Promise<ProxyResult> {
  const { signer } = await getSignerRoutingContext(auth.appId);
  if (!signer || signer.status !== "running") {
    return { status: 503, body: { error: "Signer is not running" } };
  }

  try {
    const result = await forwardToSigner({
      signer,
      path: "/discover-orchestrators",
      method: "GET",
      body: undefined,
      auth,
    });
    const responseBody = await readSignerUpstreamBody(result.response);

    if (result.response.ok) {
      const who = auth.endUserId || auth.userId || "unknown";
      console.log(`[proxy] discover-orchestrators forwarded for ${who}`);
    }

    return { status: result.response.status, body: responseBody };
  } catch (error) {
    console.error("[proxy] Failed to forward discover-orchestrators:", error);
    return { status: 502, body: { error: "Failed to reach signer" } };
  }
}
