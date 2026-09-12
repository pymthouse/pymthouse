import { v4 as uuidv4 } from "uuid";
import { insertAuditLog } from "../repo/audit";

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
  await insertAuditLog({
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
