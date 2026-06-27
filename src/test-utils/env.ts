/**
 * Temporarily override `process.env` for the duration of `fn`, restoring the
 * prior values (including deletions) afterward — for both sync and async `fn`.
 *
 * Shared by the BPP / usage tests so env-dependent flag and secret behavior can
 * be exercised without leaking state across tests.
 */
export function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> | void {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const k of keys) {
      const prev = previous.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
