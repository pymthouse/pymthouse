/** Forward `/api/v1/signer/*` to go-livepeer remote signer (Apache DMZ). */
export const SIGNING_MODE_LEGACY_REMOTE_SIGNER = "legacy_remote_signer";

/** Use livepeer-network-modules `PayerDaemon` over a unix socket (payment-daemon sender). */
export const SIGNING_MODE_LPNM_PAYER_DAEMON = "lpnm_payer_daemon";

/** Route per request: registry → LPNM; orchestrator blob → legacy or LPNM per envelope. */
export const SIGNING_MODE_DUAL = "dual";

export type SigningMode =
  | typeof SIGNING_MODE_LEGACY_REMOTE_SIGNER
  | typeof SIGNING_MODE_LPNM_PAYER_DAEMON
  | typeof SIGNING_MODE_DUAL;

export type SigningBackend =
  | typeof SIGNING_MODE_LEGACY_REMOTE_SIGNER
  | typeof SIGNING_MODE_LPNM_PAYER_DAEMON;

/** Discovery Service `entries[].serviceType` values used for billing-plan catalogs. */
export type CatalogServiceType = "legacy" | "registry";

const VALID_SIGNING_MODES: readonly string[] = [
  SIGNING_MODE_LEGACY_REMOTE_SIGNER,
  SIGNING_MODE_LPNM_PAYER_DAEMON,
  SIGNING_MODE_DUAL,
];

export function isValidSigningMode(mode: string): mode is SigningMode {
  return VALID_SIGNING_MODES.includes(mode);
}

export function isLpnmSigningMode(mode: string | null | undefined): boolean {
  return (
    mode === SIGNING_MODE_LPNM_PAYER_DAEMON || mode === SIGNING_MODE_DUAL
  );
}

export function isDualSigningMode(mode: string | null | undefined): boolean {
  return mode === SIGNING_MODE_DUAL;
}

/** Backends allowed for this app configuration. */
export function enabledSigningBackendsFromMode(
  mode: string | null | undefined,
): SigningBackend[] {
  const m = mode?.trim() || SIGNING_MODE_LEGACY_REMOTE_SIGNER;
  if (m === SIGNING_MODE_DUAL) {
    return [
      SIGNING_MODE_LEGACY_REMOTE_SIGNER,
      SIGNING_MODE_LPNM_PAYER_DAEMON,
    ];
  }
  if (m === SIGNING_MODE_LPNM_PAYER_DAEMON) {
    return [SIGNING_MODE_LPNM_PAYER_DAEMON];
  }
  return [SIGNING_MODE_LEGACY_REMOTE_SIGNER];
}

/** Catalog scopes for Plans / manifest (dual → union of both service types). */
export function catalogServiceTypesForSigningMode(
  mode: string | null | undefined,
): CatalogServiceType[] {
  if (isDualSigningMode(mode)) {
    return ["legacy", "registry"];
  }
  return isLpnmSigningMode(mode) ? ["registry"] : ["legacy"];
}

/** @deprecated Use catalogServiceTypesForSigningMode for dual apps. */
export function catalogServiceTypeForSigningMode(
  mode: string | null | undefined,
): CatalogServiceType {
  const types = catalogServiceTypesForSigningMode(mode);
  return types.length === 1 ? types[0]! : "legacy";
}
