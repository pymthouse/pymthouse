import { v4 as uuidv4 } from "uuid";
import * as jose from "jose";
import {
  deactivateActiveSigningKeys,
  getActiveSigningKeyRow,
  getSigningKeyRowByKid,
  insertSigningKey,
  listRecentSigningKeyRows,
} from "../repo/signing-keys";

const KEY_ALGORITHM = "RS256";
const KEY_SIZE = 2048;

export interface SigningKeyPair {
  kid: string;
  publicKey: jose.CryptoKey;
  privateKey: jose.CryptoKey;
}

export async function generateKeyPair(): Promise<{
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
}> {
  const kid = uuidv4();
  const { publicKey, privateKey } = await jose.generateKeyPair(KEY_ALGORITHM, {
    modulusLength: KEY_SIZE,
    extractable: true,
  });

  return {
    kid,
    publicKeyPem: await jose.exportSPKI(publicKey),
    privateKeyPem: await jose.exportPKCS8(privateKey),
  };
}

export async function createSigningKey(): Promise<string> {
  const { kid, publicKeyPem, privateKeyPem } = await generateKeyPair();
  await insertSigningKey({
    id: uuidv4(),
    kid,
    algorithm: KEY_ALGORITHM,
    publicKeyPem,
    privateKeyPem,
    active: 1,
  });
  return kid;
}

export async function rotateSigningKey(): Promise<string> {
  await deactivateActiveSigningKeys(new Date().toISOString());
  return createSigningKey();
}

export async function getActiveSigningKey(): Promise<SigningKeyPair | null> {
  const key = await getActiveSigningKeyRow();
  if (!key) return null;
  return {
    kid: key.kid,
    publicKey: await jose.importSPKI(key.publicKeyPem, KEY_ALGORITHM),
    privateKey: await jose.importPKCS8(key.privateKeyPem, KEY_ALGORITHM),
  };
}

export async function ensureSigningKey(): Promise<SigningKeyPair> {
  let keyPair = await getActiveSigningKey();
  if (!keyPair) {
    await createSigningKey();
    keyPair = await getActiveSigningKey();
  }
  if (!keyPair) throw new Error("Failed to create or retrieve signing key");
  return keyPair;
}

export async function getPublicJWKS(): Promise<jose.JSONWebKeySet> {
  const keys = await listRecentSigningKeyRows(10);
  const sorted = [...keys].sort((a, b) => {
    if (a.active === 1 && b.active !== 1) return -1;
    if (b.active === 1 && a.active !== 1) return 1;
    return 0;
  });
  const chosen = sorted.slice(0, 5);
  const jwks: jose.JWK[] = [];
  for (const key of chosen) {
    const publicKey = await jose.importSPKI(key.publicKeyPem, KEY_ALGORITHM);
    const jwk = await jose.exportJWK(publicKey);
    jwks.push({ ...jwk, kid: key.kid, alg: KEY_ALGORITHM, use: "sig" });
  }
  return { keys: jwks };
}

export async function getSigningKeyByKid(kid: string): Promise<jose.CryptoKey | null> {
  const key = await getSigningKeyRowByKid(kid);
  if (!key) return null;
  return jose.importSPKI(key.publicKeyPem, KEY_ALGORITHM);
}
