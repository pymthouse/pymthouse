import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

/**
 * OpenMeter meter groupBy `client_id` matches the public OIDC client_id emitted
 * in signed-ticket CloudEvents (auth_id prefix), not developer_apps.id when those
 * differ (legacy apps created before id === client_id).
 */
export async function resolveOpenMeterMeterClientId(appId: string): Promise<string> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("app_")) {
    return trimmed;
  }

  const rows = await db
    .select({ publicClientId: oidcClients.clientId })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, trimmed))
    .limit(1);

  const publicClientId = rows[0]?.publicClientId?.trim();
  return publicClientId || trimmed;
}
