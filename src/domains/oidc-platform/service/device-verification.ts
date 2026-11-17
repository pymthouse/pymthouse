export function deviceVerificationError(
  error: string,
  description: string,
  status = 400,
) {
  return {
    status,
    body: {
      error,
      error_description: description,
    },
  };
}

export function parseDeviceVerificationInput(body: unknown):
  | { ok: true; userCode: string; action: "lookup" | "approve" | "deny" }
  | { ok: false; status: number; body: { error: string; error_description: string } } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      ...deviceVerificationError("invalid_request", "user_code and action are required"),
    };
  }

  const userCode = (body as Record<string, unknown>).user_code;
  const action = (body as Record<string, unknown>).action;
  if (!userCode || !action) {
    return {
      ok: false,
      ...deviceVerificationError("invalid_request", "user_code and action are required"),
    };
  }
  if (action !== "lookup" && action !== "approve" && action !== "deny") {
    return {
      ok: false,
      ...deviceVerificationError(
        "invalid_request",
        "action must be lookup, approve, or deny",
      ),
    };
  }

  return { ok: true, userCode: String(userCode), action };
}
