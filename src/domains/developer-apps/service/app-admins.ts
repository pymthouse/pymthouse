type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

export interface CreateAppAdminInput {
  userId: string;
  role: string;
}

export function parseCreateAppAdminInput(body: unknown): Ok<CreateAppAdminInput> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "userId is required" };
  }

  const userId = String((body as Record<string, unknown>).userId || "").trim();
  if (!userId) {
    return { ok: false, error: "userId is required" };
  }

  const rawRole = (body as Record<string, unknown>).role;
  const role = typeof rawRole === "string" && rawRole.trim() ? rawRole.trim() : "admin";
  return { ok: true, value: { userId, role } };
}

export function parseDeleteAppAdminInput(userId: string | null): Ok<string> | Err {
  if (!userId) {
    return { ok: false, error: "userId is required" };
  }
  return { ok: true, value: userId };
}
