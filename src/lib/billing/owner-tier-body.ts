/**
 * Safe JSON body field readers for admin Owner Paid tier routes.
 * Avoids String(unknown) which Sonar flags as '[object Object]' stringification.
 */

export function readRequiredStringField(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

export function readOptionalStringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

/** `undefined` = omit; `null` = clear; string = set. */
export function readNullableStringField(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export function readOptionalNumberField(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  return typeof value === "number" ? value : undefined;
}

export function readOptionalBooleanField(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}
