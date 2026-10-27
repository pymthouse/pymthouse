import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { oidcClients } from "@/db/schema";

export async function getDeviceVerificationClientPolicy(clientId: string) {
  const rows = await db
    .select({
      deviceThirdPartyInitiateLogin: oidcClients.deviceThirdPartyInitiateLogin,
      clientSecretHash: oidcClients.clientSecretHash,
    })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}
