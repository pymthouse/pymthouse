/**
 * Auth Proxy / Wallet Kit config id for the Turnkey org region.
 * Single place the variable name is spelled, so a region change is one edit.
 */
export function getTurnkeyWalletConfigId(): string | undefined {
  return process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim() || undefined;
}

/**
 * True when public Turnkey Wallet Kit env is set (client can show embedded wallet UI).
 */
export function isTurnkeyWalletConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
    getTurnkeyWalletConfigId()
  );
}
