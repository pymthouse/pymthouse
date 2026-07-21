/**
 * Strip CR/LF so user-controlled values cannot forge additional log lines (CWE-117).
 */
export function sanitizeForLog(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "object") {
    if (value instanceof Error) {
      return value.message.replace(/[\n\r]/g, "");
    }
    try {
      return JSON.stringify(value).replace(/[\n\r]/g, "");
    } catch {
      return "[unserializable]";
    }
  }
  return String(value).replace(/[\n\r]/g, "");
}
