import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { authAuditLog } from "@/db/schema";

export function createCorrelationId() {
  return uuidv4();
}

export async function writeAuditLog(entry: {
  clientId?: string | null;
  actorUserId?: string | null;
  action: string;
  status: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(authAuditLog).values({
    id: uuidv4(),
    clientId: entry.clientId || null,
    actorUserId: entry.actorUserId || null,
    action: entry.action,
    status: entry.status,
    correlationId: entry.correlationId || createCorrelationId(),
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    createdAt: new Date().toISOString(),
  });
}
