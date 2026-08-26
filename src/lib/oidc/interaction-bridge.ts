import { getClient } from "@/lib/oidc/clients";
import { PostgresOidcAdapter } from "@/lib/oidc/adapter";
import { isDcrClientId } from "@/lib/oidc/dcr-client";

export { oidcInteractionSubmitPath } from "@/lib/oidc/interaction-path";

export type OidcInteractionDetails = {
  uid: string;
  prompt: { name: string; details: Record<string, unknown> };
  params: Record<string, unknown>;
  session?: { accountId?: string };
  clientName?: string;
};

type InteractionPayload = {
  uid?: unknown;
  jti?: unknown;
  exp?: unknown;
  prompt?: unknown;
  params?: unknown;
  session?: unknown;
};

export function mapInteractionPayload(
  uid: string,
  payload: InteractionPayload,
  clientName?: string,
  nowMs = Date.now(),
): OidcInteractionDetails | null {
  if (typeof payload.exp === "number" && payload.exp * 1000 <= nowMs) {
    return null;
  }

  const prompt = payload.prompt;
  if (!prompt || typeof prompt !== "object") {
    return null;
  }
  const promptObj = prompt as { name?: unknown; details?: unknown };
  if (typeof promptObj.name !== "string" || !promptObj.name) {
    return null;
  }

  const params =
    payload.params && typeof payload.params === "object"
      ? (payload.params as Record<string, unknown>)
      : {};
  const session =
    payload.session && typeof payload.session === "object"
      ? (payload.session as { accountId?: string })
      : undefined;

  return {
    uid:
      (typeof payload.uid === "string" && payload.uid) ||
      (typeof payload.jti === "string" && payload.jti) ||
      uid,
    prompt: {
      name: promptObj.name,
      details:
        promptObj.details && typeof promptObj.details === "object"
          ? (promptObj.details as Record<string, unknown>)
          : {},
    },
    params,
    session,
    clientName,
  };
}

async function resolveInteractionClientName(
  clientId: string,
): Promise<string | undefined> {
  const registered = await getClient(clientId);
  if (registered?.displayName) {
    return registered.displayName;
  }
  if (!isDcrClientId(clientId)) {
    return undefined;
  }
  const client = await new PostgresOidcAdapter("Client").find(clientId);
  const name = (client as { client_name?: unknown } | undefined)?.client_name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return undefined;
}

/**
 * Read the in-flight interaction from the adapter. Pages must not HTTP-fetch
 * `/api/v1/oidc/interaction/:uid` — that same-origin call deadlocks the first
 * Claude DCR authorize when the OIDC isolate is still handling `/auth`.
 */
export async function loadOidcInteractionDetails(
  uid: string,
): Promise<OidcInteractionDetails | null> {
  const adapter = new PostgresOidcAdapter("Interaction");
  // oidc-provider v9 aliases Interaction.uid to jti, so the URL uid is the
  // primary key. The uid column is often null on older rows.
  const payload = (await adapter.find(uid)) ?? (await adapter.findByUid(uid));
  if (!payload) {
    return null;
  }
  const params = (payload as InteractionPayload).params;
  const clientId =
    params && typeof params === "object"
      ? (params as { client_id?: unknown }).client_id
      : undefined;
  const clientName =
    typeof clientId === "string" && clientId
      ? await resolveInteractionClientName(clientId)
      : undefined;
  return mapInteractionPayload(uid, payload, clientName);
}
