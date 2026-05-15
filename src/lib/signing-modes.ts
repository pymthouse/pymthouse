/** Forward `/api/v1/signer/*` to go-livepeer remote signer (Apache DMZ). */
export const SIGNING_MODE_LEGACY_REMOTE_SIGNER = "legacy_remote_signer";

/** Use livepeer-network-modules `PayerDaemon` over a unix socket (payment-daemon sender). */
export const SIGNING_MODE_LPNM_PAYER_DAEMON = "lpnm_payer_daemon";

export type SigningMode =
  | typeof SIGNING_MODE_LEGACY_REMOTE_SIGNER
  | typeof SIGNING_MODE_LPNM_PAYER_DAEMON;
