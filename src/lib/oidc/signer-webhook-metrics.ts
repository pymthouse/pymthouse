/**
 * Phase-level latency logging for the remote-signer webhook (issue #248).
 * One structured line per phase so cold/warm latency is observable per
 * invocation: end-user verification, composite token exchange, balance
 * lookup, and total webhook duration.
 */

export type SignerWebhookPhase =
  | "end_user_verify"
  | "token_exchange"
  | "balance_check"
  | "total";

export function logSignerWebhookPhase(
  phase: SignerWebhookPhase,
  durationMs: number,
  ok: boolean,
): void {
  console.info(
    `[remote-signer] phase=${phase} duration_ms=${Math.round(durationMs)} ok=${ok}`,
  );
}

/** Run `fn`, log its duration under `phase`, and re-throw failures unchanged. */
export async function timeSignerWebhookPhase<T>(
  phase: SignerWebhookPhase,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await fn();
    logSignerWebhookPhase(phase, performance.now() - startedAt, true);
    return result;
  } catch (err) {
    logSignerWebhookPhase(phase, performance.now() - startedAt, false);
    throw err;
  }
}
