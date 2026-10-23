import { hashToken } from "@/domains/identity-access/runtime/request-auth";
import { generateApiKeyValue } from "@/domains/oidc-platform/runtime/programmatic-tokens";
import {
  createCorrelationId,
  writeAuditLog,
} from "@/domains/identity-access/runtime/audit";
import {
  createAppKeyRecord,
  getSubscriptionForApp,
  listAppKeys,
  revokeAppKey,
} from "../repo/app-keys";
import { parseCreateAppKeyInput, parseDeleteAppKeyInput } from "../service/app-keys";

export async function readAppKeys(clientId: string, appId: string) {
  const keys = await listAppKeys(appId);
  return {
    keys: keys.map((key) => ({
      ...key,
      clientId,
    })),
  };
}

export async function createAppKey(params: {
  clientId: string;
  appId: string;
  actorUserId: string | null;
  body: unknown;
}): Promise<
  | {
      ok: true;
      body: {
        apiKey: string;
        id: string;
        message: string;
        correlation_id: string;
      };
    }
  | { ok: false; status: 404; body: { error: string } }
> {
  const parsed = parseCreateAppKeyInput(params.body);
  const { subscriptionId, label } = parsed.value;

  if (subscriptionId) {
    const subscription = await getSubscriptionForApp(subscriptionId, params.appId);
    if (!subscription) {
      return { ok: false, status: 404, body: { error: "Subscription not found" } };
    }
  }

  const apiKeyValue = generateApiKeyValue();
  const id = crypto.randomUUID();
  await createAppKeyRecord({
    id,
    keyHash: hashToken(apiKeyValue),
    userId: params.actorUserId,
    clientId: params.appId,
    subscriptionId,
    label,
    status: "active",
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: params.appId,
    actorUserId: params.actorUserId,
    action: "api_key_created",
    status: "success",
    correlationId,
    metadata: {
      keyId: id,
      subscriptionId,
      label,
    },
  });

  return {
    ok: true,
    body: {
      apiKey: apiKeyValue,
      id,
      message: "Store this API key securely. It will not be shown again.",
      correlation_id: correlationId,
    },
  };
}

export async function revokeExistingAppKey(params: {
  appId: string;
  actorUserId: string | null;
  keyId: string | null;
}): Promise<
  | { ok: true; body: { success: true; correlation_id: string } }
  | { ok: false; status: 400 | 404; body: { error: string } }
> {
  const parsed = parseDeleteAppKeyInput(params.keyId);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { error: parsed.error } };
  }

  const revoked = await revokeAppKey(parsed.value, params.appId, new Date().toISOString());
  if (revoked.length === 0) {
    return { ok: false, status: 404, body: { error: "Key not found" } };
  }

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: params.appId,
    actorUserId: params.actorUserId,
    action: "api_key_revoked",
    status: "success",
    correlationId,
    metadata: { keyId: parsed.value },
  });

  return { ok: true, body: { success: true, correlation_id: correlationId } };
}
