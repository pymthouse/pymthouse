/** Legacy go-livepeer HTTP port stored on older signer_config rows (bare signer). */
const LEGACY_BARE_SIGNER_PORT = 8081;

/** Host-published Apache DMZ listener (maps legacy 8081 rows to real DMZ port). */
const DEFAULT_SIGNER_DMZ_HOST_PORT = 8080;

/**
 * Map persisted `signerPort` to the TCP port published on the host for Apache
 * (signer-dmz). Matches docker compose env in signer control route.
 */
export function resolveDmzHostPort(signerPort: number | undefined): number {
  if (!signerPort || signerPort === LEGACY_BARE_SIGNER_PORT) {
    return DEFAULT_SIGNER_DMZ_HOST_PORT;
  }
  return signerPort;
}
