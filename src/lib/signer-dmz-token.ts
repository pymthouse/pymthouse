import { SignJWT } from "jose";
import { ensureSigningKey } from "@/lib/oidc/jwks";
import { getIssuer } from "@/lib/oidc/issuer-urls";

const DMZ_TOKEN_TTL_SECONDS = 4 * 60;

export type SignerDmzGate = "http" | "cli";

/**
 * Short-lived RS256 JWT for the remote signer Apache DMZ. Minted only on the
 * PymtHouse server after user/API auth; Apache validates signature + iss/aud + scope.
 *
 * - gate "http" → scope "sign:job" (go-livepeer HTTP API, port 8081)
 * - gate "cli"   → scope "admin" (CLI API, port 4935, proxied under /__signer_cli)
 */
export async function issueSignerDmzToken(input: {
  gate: SignerDmzGate;
  subject: string;
}): Promise<string> {
  const issuer = getIssuer();
  const keyPair = await ensureSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const scope = input.gate === "http" ? "sign:job" : "admin";

  return new SignJWT({
    scope,
    signer_proxy: true,
    gate: input.gate,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyPair.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(input.subject)
    .setJti(`dmz_${input.gate}_${now}_${Math.random().toString(36).slice(2, 10)}`)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + DMZ_TOKEN_TTL_SECONDS)
    .sign(keyPair.privateKey);
}
