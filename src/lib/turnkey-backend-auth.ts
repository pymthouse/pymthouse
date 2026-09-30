/** Server-only switch. Rollback is an env change plus redeploy, not a client rebuild. */
export function isTurnkeyBackendAuthEnabled(): boolean {
  return process.env.TURNKEY_BACKEND_AUTH?.trim() === "true";
}
