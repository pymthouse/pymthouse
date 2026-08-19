export function normalizeUserCode(value: string): string {
  return value
    .replace(/[a-z]/g, (char) => char.toUpperCase())
    .replace(/\W/g, "");
}
