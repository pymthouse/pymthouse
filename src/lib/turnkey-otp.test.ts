import test from "node:test";
import assert from "node:assert/strict";
import { otpLoginSignatureMessage } from "./turnkey-otp";

function tokenWith(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `hdr.${body}.sig`;
}

test("otp login message binds the token id and session public key", () => {
  const message = otpLoginSignatureMessage({
    verificationToken: tokenWith({
      id: "otp-1",
      public_key: "02aa",
    }),
    publicKey: "02aa",
  });
  assert.equal(message.tokenId, "otp-1");
  assert.deepEqual(JSON.parse(message.message), {
    login: { publicKey: "02aa" },
    tokenId: "otp-1",
    type: "USAGE_TYPE_LOGIN",
  });
});
