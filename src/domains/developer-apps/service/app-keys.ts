type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

export interface ParsedCreateAppKeyInput {
  subscriptionId: string | null;
  label: string | null;
}

export function parseCreateAppKeyInput(body: unknown): Ok<ParsedCreateAppKeyInput> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: true, value: { subscriptionId: null, label: null } };
  }

  return {
    ok: true,
    value: {
      subscriptionId:
        typeof (body as Record<string, unknown>).subscriptionId === "string"
          ? (body as Record<string, unknown>).subscriptionId as string
          : null,
      label:
        typeof (body as Record<string, unknown>).label === "string"
          ? (body as Record<string, unknown>).label as string
          : null,
    },
  };
}

export function parseDeleteAppKeyInput(keyId: string | null): Ok<string> | Err {
  if (!keyId) {
    return { ok: false, error: "keyId is required" };
  }
  return { ok: true, value: keyId };
}
