import { db } from "@/db/index";
import { streamSessions } from "@/db/schema";
import type { StreamSession } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

export const ACTIVE_STREAM_PAYMENT_WINDOW_MINUTES = 5;
export const ACTIVE_STREAM_PAYMENT_WINDOW_LABEL = `paid in last ${ACTIVE_STREAM_PAYMENT_WINDOW_MINUTES} min`;

type ActiveStreamIdRow = {
  id: string;
};

type CountRow = {
  count: number | string;
};

function isMissingRelationError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  const direct = error as { code?: string };
  return cause?.code === "42P01" || direct?.code === "42P01";
}

async function countActiveStreamsFallback(): Promise<number> {
  const rows = await db.execute<CountRow>(sql`
    SELECT COUNT(DISTINCT t.stream_session_id)::int AS count
    FROM transactions t
    WHERE t.type = 'usage'
      AND t.status = 'confirmed'
      AND t.stream_session_id IS NOT NULL
      AND t.created_at::timestamptz > NOW() - INTERVAL '5 minutes'
  `);
  const count = rows[0]?.count ?? 0;
  return typeof count === "number" ? count : Number(count);
}

export async function countActiveStreamsByRecentPayment(): Promise<number> {
  try {
    const rows = await db.execute<CountRow>(sql`
      SELECT COUNT(*)::int AS count
      FROM active_stream_ids_by_recent_payment
    `);
    const count = rows[0]?.count ?? 0;
    return typeof count === "number" ? count : Number(count);
  } catch (error) {
    if (isMissingRelationError(error)) {
      return countActiveStreamsFallback();
    }
    throw error;
  }
}

export async function getActiveStreamSessionsByRecentPayment(
  limit?: number,
): Promise<StreamSession[]> {
  const limitClause = typeof limit === "number" ? sql`LIMIT ${limit}` : sql``;
  let idRows: ActiveStreamIdRow[];
  try {
    idRows = await db.execute<ActiveStreamIdRow>(sql`
      SELECT grouped.stream_session_id AS id
      FROM (
        SELECT t.stream_session_id, MAX(t.created_at::timestamptz) AS last_payment_at
        FROM transactions t
        INNER JOIN active_stream_ids_by_recent_payment a ON a.id = t.stream_session_id
        WHERE t.type = 'usage'
          AND t.status = 'confirmed'
          AND t.stream_session_id IS NOT NULL
          AND t.created_at::timestamptz > NOW() - INTERVAL '5 minutes'
        GROUP BY t.stream_session_id
      ) grouped
      ORDER BY grouped.last_payment_at DESC
      ${limitClause}
    `);
  } catch (error) {
    if (!isMissingRelationError(error)) throw error;
    idRows = await db.execute<ActiveStreamIdRow>(sql`
      SELECT grouped.stream_session_id AS id
      FROM (
        SELECT t.stream_session_id, MAX(t.created_at::timestamptz) AS last_payment_at
        FROM transactions t
        WHERE t.type = 'usage'
          AND t.status = 'confirmed'
          AND t.stream_session_id IS NOT NULL
          AND t.created_at::timestamptz > NOW() - INTERVAL '5 minutes'
        GROUP BY t.stream_session_id
      ) grouped
      ORDER BY grouped.last_payment_at DESC
      ${limitClause}
    `);
  }
  const ids = idRows.map((row) => row.id);
  if (ids.length === 0) return [];

  const sessions = await db
    .select()
    .from(streamSessions)
    .where(inArray(streamSessions.id, ids));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));

  return ids
    .map((id) => sessionById.get(id))
    .filter((session): session is StreamSession => !!session);
}
