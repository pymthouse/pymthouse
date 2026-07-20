import { db } from "@/db/index";
import { authAuditLog } from "@/db/schema";

export async function insertAuditLog(entry: {
  id: string;
  clientId: string | null;
  actorUserId: string | null;
  action: string;
  status: string;
  correlationId: string;
  metadata: string | null;
  createdAt: string;
}) {
  await db.insert(authAuditLog).values(entry);
}
