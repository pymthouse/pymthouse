type Ok<T> = { ok: true; value: T };
type Err = {
  ok: false;
  status: 400 | 500;
  body: {
    error: string;
    error_description?: string;
  };
};

export interface OidcCredentialClient {
  id: string;
  clientId: string;
  tokenEndpointAuthMethod: string;
}

export function resolveSecretRotationTarget(params: {
  oidcClientId: string | null;
  m2mOidcClientId: string | null;
  primaryClient: OidcCredentialClient | null;
}): Ok<string> | Err {
  if (!params.oidcClientId) {
    return {
      ok: false,
      status: 400,
      body: { error: "App has no OIDC client configured" },
    };
  }

  if (params.m2mOidcClientId) {
    return { ok: true, value: params.m2mOidcClientId };
  }

  if (!params.primaryClient) {
    return {
      ok: false,
      status: 500,
      body: { error: "OIDC client not found" },
    };
  }

  if (params.primaryClient.tokenEndpointAuthMethod === "none") {
    return {
      ok: false,
      status: 400,
      body: {
        error: "interactive_public_no_secret",
        error_description:
          "Enable Backend device helper in Auth & Scopes, then generate a secret for the confidential client.",
      },
    };
  }

  return { ok: true, value: params.primaryClient.id };
}

export function validateSecretRotationClient(
  client: OidcCredentialClient | null,
): Ok<OidcCredentialClient> | Err {
  if (!client) {
    return {
      ok: false,
      status: 500,
      body: { error: "OIDC client not found" },
    };
  }

  if (client.tokenEndpointAuthMethod === "none") {
    return {
      ok: false,
      status: 400,
      body: {
        error: "public_client_no_secret",
        error_description:
          "This client cannot hold a secret. Use the Backend helper client for confidential credentials.",
      },
    };
  }

  return { ok: true, value: client };
}
