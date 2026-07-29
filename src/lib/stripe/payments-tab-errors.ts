/**
 * Client-safe Payments-tab `?error=` mapping (no Node builtins).
 */

const PAYMENTS_TAB_ERROR_MESSAGES = new Map<string, string>([
  ["access_denied", "Stripe connection was cancelled."],
  ["invalid_request", "Stripe rejected the connection request."],
  ["invalid_client", "Stripe Connect is misconfigured on this environment."],
  ["invalid_grant", "Stripe authorization code was invalid or expired."],
  ["unauthorized_client", "Stripe rejected this Connect client."],
  ["unsupported_response_type", "Stripe rejected the Connect response type."],
  ["invalid_scope", "Stripe rejected the requested Connect scope."],
  ["server_error", "Stripe reported a temporary server error. Try again."],
  ["temporarily_unavailable", "Stripe is temporarily unavailable. Try again."],
  ["oauth_denied", "Stripe connection was denied."],
  ["invalid_oauth_state", "Stripe connection link was invalid. Try again."],
  ["oauth_state_expired", "Stripe connection link expired. Try again."],
  ["connect_misconfigured", "Stripe Connect is misconfigured on this environment."],
  ["oauth_exchange_failed", "Could not complete Stripe connection. Try again."],
  ["oauth_failed", "Stripe connection failed. Try again."],
  ["missing_oauth_params", "Stripe connection was incomplete. Try again."],
]);

/**
 * Map Payments-tab `?error=` query values to fixed copy.
 * Unknown / free-form values are ignored (prevents reflected phishing).
 */
export function paymentsTabErrorMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return PAYMENTS_TAB_ERROR_MESSAGES.get(raw.trim().toLowerCase()) ?? null;
}
