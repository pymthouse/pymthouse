import { SIGNING_MODE_LPNM_PAYER_DAEMON } from "@/lib/signing-modes";

const DEFAULT_PAYER_SOCKET = "/run/pymthouse/payer.sock";

export function resolvePayerDaemonSocketPath(
  appOverride: string | null | undefined,
): string {
  const fromApp = appOverride?.trim();
  if (fromApp) return fromApp;
  const fromEnv = process.env.LPNM_PAYER_DAEMON_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_PAYER_SOCKET;
}

/** Fallback base URL for payer-daemon ticket-params HTTP fetch when OrchestratorInfo has no transcoder. */
export function resolveTicketParamsBaseUrlOverride(): string {
  const u = process.env.LPNM_TICKET_PARAMS_BASE_URL?.trim();
  return u?.replace(/\/+$/, "") ?? "";
}

export function resolveDiscoveryOrchServiceUrl(): string {
  return (
    process.env.LPNM_DISCOVERY_ORCH_URL?.trim().replace(/\/+$/, "") ?? ""
  );
}

export function defaultPaymentCapabilityOffering(): {
  capability: string;
  offering: string;
} {
  return {
    capability:
      process.env.LPNM_PAYMENT_CAPABILITY?.trim() || "live-video-to-video",
    offering: process.env.LPNM_PAYMENT_OFFERING?.trim() || "default",
  };
}

export function isLpnmSigningMode(mode: string | null | undefined): boolean {
  return mode === SIGNING_MODE_LPNM_PAYER_DAEMON;
}
