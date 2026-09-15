import { rotateClientSecret } from "@/domains/oidc-platform/runtime/clients";
import { getOidcCredentialClientById } from "../repo/app-credentials";
import {
  resolveSecretRotationTarget,
  validateSecretRotationClient,
} from "../service/app-credentials";

export async function rotateAppClientSecret(params: {
  oidcClientId: string | null;
  m2mOidcClientId: string | null;
}): Promise<
  | {
      ok: true;
      body: {
        clientId: string;
        clientSecret: string;
        message: string;
      };
    }
  | {
      ok: false;
      status: 400 | 500;
      body: {
        error: string;
        error_description?: string;
      };
    }
> {
  const primaryClient = params.oidcClientId
    ? await getOidcCredentialClientById(params.oidcClientId)
    : null;

  const target = resolveSecretRotationTarget({
    oidcClientId: params.oidcClientId,
    m2mOidcClientId: params.m2mOidcClientId,
    primaryClient,
  });
  if (!target.ok) {
    return target;
  }

  const targetClient =
    primaryClient?.id === target.value
      ? primaryClient
      : await getOidcCredentialClientById(target.value);
  const validated = validateSecretRotationClient(targetClient);
  if (!validated.ok) {
    return validated;
  }

  const secret = await rotateClientSecret(validated.value.clientId);
  if (!secret) {
    return {
      ok: false,
      status: 500,
      body: { error: "Failed to generate secret" },
    };
  }

  return {
    ok: true,
    body: {
      clientId: validated.value.clientId,
      clientSecret: secret,
      message: "Store this secret securely. It will not be shown again.",
    },
  };
}
