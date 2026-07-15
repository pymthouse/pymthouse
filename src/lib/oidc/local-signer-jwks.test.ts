import test from "node:test";
import assert from "node:assert/strict";
import * as jose from "jose";
import { createLocalSignerJwksResolver } from "@/lib/oidc/local-signer-jwks";

const ISSUER = "https://pymthouse.com/api/v1/oidc";

async function makeSigningKey(kid: string) {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { jwk, privateKey };
}

async function signToken(privateKey: jose.CryptoKey, kid: string) {
  return new jose.SignJWT({ scope: "sign:job" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

test("local signer JWKS resolver verifies tokens and caches the keyset", async () => {
  const key = await makeSigningKey("kid-1");
  let loads = 0;
  const resolver = createLocalSignerJwksResolver({
    loadJwks: async () => {
      loads += 1;
      return { keys: [key.jwk] };
    },
  });

  const token = await signToken(key.privateKey, "kid-1");
  for (let i = 0; i < 3; i += 1) {
    const { payload } = await jose.jwtVerify(token, resolver, {
      issuer: ISSUER,
      audience: ISSUER,
    });
    assert.equal(payload.iss, ISSUER);
  }
  assert.equal(loads, 1);
});

test("local signer JWKS resolver coalesces concurrent initial loads", async () => {
  const key = await makeSigningKey("kid-1");
  let loads = 0;
  const resolver = createLocalSignerJwksResolver({
    loadJwks: async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { keys: [key.jwk] };
    },
  });

  const token = await signToken(key.privateKey, "kid-1");
  await Promise.all(
    Array.from({ length: 5 }, () =>
      jose.jwtVerify(token, resolver, { issuer: ISSUER, audience: ISSUER }),
    ),
  );
  assert.equal(loads, 1);
});

test("local signer JWKS resolver reloads after rotation to an unknown kid", async () => {
  const oldKey = await makeSigningKey("kid-old");
  const newKey = await makeSigningKey("kid-new");
  let keys = [oldKey.jwk];
  let loads = 0;
  let nowMs = 0;
  const resolver = createLocalSignerJwksResolver({
    loadJwks: async () => {
      loads += 1;
      return { keys };
    },
    now: () => nowMs,
  });

  const oldToken = await signToken(oldKey.privateKey, "kid-old");
  await jose.jwtVerify(oldToken, resolver, { issuer: ISSUER, audience: ISSUER });
  assert.equal(loads, 1);

  keys = [oldKey.jwk, newKey.jwk];
  nowMs += 60_000; // past the forced-refresh floor, within the TTL
  const newToken = await signToken(newKey.privateKey, "kid-new");
  const { protectedHeader } = await jose.jwtVerify(newToken, resolver, {
    issuer: ISSUER,
    audience: ISSUER,
  });
  assert.equal(protectedHeader.kid, "kid-new");
  assert.equal(loads, 2);
});

test("local signer JWKS resolver does not hammer reloads for unknown kids", async () => {
  const key = await makeSigningKey("kid-1");
  const rogue = await makeSigningKey("kid-rogue");
  let loads = 0;
  const resolver = createLocalSignerJwksResolver({
    loadJwks: async () => {
      loads += 1;
      return { keys: [key.jwk] };
    },
  });

  const good = await signToken(key.privateKey, "kid-1");
  await jose.jwtVerify(good, resolver, { issuer: ISSUER, audience: ISSUER });

  const bad = await signToken(rogue.privateKey, "kid-rogue");
  await assert.rejects(
    jose.jwtVerify(bad, resolver, { issuer: ISSUER, audience: ISSUER }),
    jose.errors.JWKSNoMatchingKey,
  );
  // Keyset was just loaded, so the unknown kid must not trigger another load.
  assert.equal(loads, 1);
});
