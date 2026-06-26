import type { SignerSession } from "@/lib/openapi/schemas/credentials-types";

export function buildSignerSessionEnvelope(input: {
  access_token: string;
  expires_in: number;
  scope: string;
  balanceUsdMicros: string;
  lifetimeGrantedUsdMicros: string;
  signer_url?: string;
  issued_token_type?: SignerSession["issued_token_type"];
  correlation_id?: string;
}): SignerSession {
  const scope = input.scope.trim() || "sign:job";
  const body: SignerSession = {
    access_token: input.access_token,
    token_type: "Bearer",
    expires_in: input.expires_in,
    scope,
    balanceUsdMicros: input.balanceUsdMicros,
    lifetimeGrantedUsdMicros: input.lifetimeGrantedUsdMicros,
  };
  const signerUrl = input.signer_url?.trim();
  if (signerUrl) {
    body.signer_url = signerUrl;
  }
  if (input.issued_token_type) {
    body.issued_token_type = input.issued_token_type;
  }
  if (input.correlation_id) {
    body.correlation_id = input.correlation_id;
  }
  return body;
}
