import { db } from "@/db/index";
import { oidcSigningKeys } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import * as jose from "jose";

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

  const publicKeyPem = await jose.exportSPKI(publicKey);
  const privateKeyPem = await jose.exportPKCS8(privateKey);

  return { kid, publicKeyPem, privateKeyPem };
}

export async function createSigningKey(): Promise<string> {
  const { kid, publicKeyPem, privateKeyPem } = await generateKeyPair();

  await db.insert(oidcSigningKeys).values({
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
  const now = new Date().toISOString();

  await db
    .update(oidcSigningKeys)
    .set({ active: 0, rotatedAt: now })
    .where(eq(oidcSigningKeys.active, 1));

  return createSigningKey();
}

export async function getActiveSigningKey(): Promise<SigningKeyPair | null> {
  const rows = await db
    .select()
    .from(oidcSigningKeys)
    .where(eq(oidcSigningKeys.active, 1))
    .orderBy(desc(oidcSigningKeys.createdAt))
    .limit(1);
  const key = rows[0];

  if (!key) return null;

  const publicKey = await jose.importSPKI(key.publicKeyPem, KEY_ALGORITHM);
  const privateKey = await jose.importPKCS8(key.privateKeyPem, KEY_ALGORITHM);

  return {
    kid: key.kid,
    publicKey,
    privateKey,
  };
}

export async function ensureSigningKey(): Promise<SigningKeyPair> {
  let keyPair = await getActiveSigningKey();
  if (!keyPair) {
    await createSigningKey();
    keyPair = await getActiveSigningKey();
  }
  if (!keyPair) {
    throw new Error("Failed to create or retrieve signing key");
  }
  return keyPair;
}

export async function getPublicJWKS(): Promise<jose.JSONWebKeySet> {
  const keys = await db
    .select()
    .from(oidcSigningKeys)
    .orderBy(desc(oidcSigningKeys.createdAt))
    .limit(10);

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
    jwks.push({
      ...jwk,
      kid: key.kid,
      alg: KEY_ALGORITHM,
      use: "sig",
    });
  }

  return { keys: jwks };
}

export async function getSigningKeyByKid(kid: string): Promise<jose.CryptoKey | null> {
  const rows = await db
    .select()
    .from(oidcSigningKeys)
    .where(eq(oidcSigningKeys.kid, kid))
    .limit(1);
  const key = rows[0];

  if (!key) return null;

  return jose.importSPKI(key.publicKeyPem, KEY_ALGORITHM);
}
