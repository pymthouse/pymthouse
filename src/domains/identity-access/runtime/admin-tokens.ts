import { listActiveAdminSessions, revokeSession, createSession } from "./request-auth";

export async function issueAdminToken(params: {
  adminUserId: string;
  scopes: string;
  expiresInDays: number;
  endUserId?: string;
  label?: string;
}) {
  return createSession({
    userId: params.adminUserId,
    endUserId: params.endUserId,
    label: params.label,
    scopes: params.scopes,
    expiresInDays: params.expiresInDays,
  });
}

export async function listAdminTokens() {
  return listActiveAdminSessions();
}

export async function revokeAdminToken(sessionId: string) {
  return revokeSession(sessionId);
}
