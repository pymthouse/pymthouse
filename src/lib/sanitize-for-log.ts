/**
 * Strip CR/LF so user-controlled values cannot forge additional log lines (CWE-117).
 */
export function sanitizeForLog(value: unknown): string {
  return String(value ?? "").replace(/[\n\r]/g, "");
}
