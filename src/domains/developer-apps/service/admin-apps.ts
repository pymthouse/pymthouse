type Ok<T> = { ok: true; value: T };
type Err = { ok: false; status: 400; body: { error: string } };

export function parseAdminReviewInput(body: unknown): Ok<{
  action: "approve" | "reject";
  notes: string | null;
}> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, body: { error: "action must be 'approve' or 'reject'" } };
  }

  const action = (body as Record<string, unknown>).action;
  if (action !== "approve" && action !== "reject") {
    return { ok: false, status: 400, body: { error: "action must be 'approve' or 'reject'" } };
  }

  const notes = typeof (body as Record<string, unknown>).notes === "string"
    ? (body as Record<string, unknown>).notes as string
    : null;
  return { ok: true, value: { action, notes } };
}
