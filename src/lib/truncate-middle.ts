/**
 * Keep the start and end of a long id visible; drop characters from the middle.
 * Short strings are returned unchanged.
 */
export function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= 2) return value.slice(0, maxLength);
  const budget = maxLength - 1;
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
