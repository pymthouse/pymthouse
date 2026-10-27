import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { oidcClients } from "@/db/schema";

export async function getOidcCredentialClientById(id: string) {
  const rows = await db
    .select({
      id: oidcClients.id,
      clientId: oidcClients.clientId,
      tokenEndpointAuthMethod: oidcClients.tokenEndpointAuthMethod,
    })
    .from(oidcClients)
    .where(eq(oidcClients.id, id))
    .limit(1);
  return rows[0] ?? null;
}
