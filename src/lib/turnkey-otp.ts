import { fromDerSignature } from "@turnkey/crypto";
import { signWithApiKey } from "@turnkey/api-key-stamper";
import { uint8ArrayToHexString } from "@turnkey/encoding";

export type OtpClientSignature = {
  message: string;
  publicKey: string;
  scheme: "CLIENT_SIGNATURE_SCHEME_API_P256";
  signature: string;
};

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Invalid verification token");
  const parsed: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid verification token");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Message Turnkey requires the browser key to sign before otpLogin.
 * The signature is raw P-256 r||s, not DER.
 */
export function otpLoginSignatureMessage(input: {
  verificationToken: string;
  publicKey: string;
}): { message: string; tokenId: string; verificationPublicKey: string } {
  const decoded = decodeJwtPayload(input.verificationToken);
  const tokenId = decoded.id;
  const verificationPublicKey = decoded.public_key;
  if (typeof tokenId !== "string" || !tokenId) {
    throw new Error("Verification token is missing id");
  }
  if (typeof verificationPublicKey !== "string" || !verificationPublicKey) {
    throw new Error("Verification token is missing public_key");
  }
  const message = JSON.stringify({
    login: { publicKey: input.publicKey },
    tokenId,
    type: "USAGE_TYPE_LOGIN",
  });
  return { message, tokenId, verificationPublicKey };
}

export async function signOtpLoginClientSignature(input: {
  verificationToken: string;
  publicKey: string;
  privateKey: string;
}): Promise<OtpClientSignature> {
  const { message, verificationPublicKey } = otpLoginSignatureMessage({
    verificationToken: input.verificationToken,
    publicKey: input.publicKey,
  });
  if (verificationPublicKey !== input.publicKey) {
    throw new Error("Verification token is bound to a different public key");
  }
  const der = await signWithApiKey({
    content: message,
    publicKey: input.publicKey,
    privateKey: input.privateKey,
  });
  return {
    message,
    publicKey: input.publicKey,
    scheme: "CLIENT_SIGNATURE_SCHEME_API_P256",
    signature: uint8ArrayToHexString(fromDerSignature(der)),
  };
}
