import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export async function listPublishedHomeApps() {
  return db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      subtitle: developerApps.subtitle,
      description: developerApps.description,
      category: developerApps.category,
      developerName: developerApps.developerName,
      marketplaceFeatured: developerApps.marketplaceFeatured,
      publishedAt: developerApps.publishedAt,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      and(
        eq(developerApps.status, "approved"),
        isNotNull(developerApps.publishedAt),
      ),
    )
    .orderBy(desc(developerApps.publishedAt));
}

export async function listPopularPublishedHomeAppIds(limit: number) {
  return db.execute<{ id: string }>(sql`
    SELECT d.id
    FROM developer_apps d
    LEFT JOIN (
      SELECT COALESCE(client_id, app_id) AS aid, COUNT(*)::bigint AS cnt
      FROM transactions
      WHERE type = 'usage'
        AND status = 'confirmed'
        AND COALESCE(client_id, app_id) IS NOT NULL
      GROUP BY COALESCE(client_id, app_id)
    ) u ON u.aid = d.id
    WHERE d.status = 'approved'
      AND d.published_at IS NOT NULL
    ORDER BY COALESCE(u.cnt, 0) DESC, d.published_at::timestamptz DESC NULLS LAST
    LIMIT ${limit}
  `);
}
