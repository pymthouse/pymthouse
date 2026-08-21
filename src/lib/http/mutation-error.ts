/**
 * Plan / billing mutations can fail with an activation problem+json body,
 * which carries `detail`/`title` instead of `error`. Prefer those so the UI
 * does not show a bare status code.
 */
export function readMutationError(
  body: Record<string, unknown>,
  fallback: string,
): string {
  for (const key of ["error", "detail", "title"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return fallback;
}
