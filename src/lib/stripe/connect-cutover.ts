export type ConnectCutoverFinding = {
  code: string;
  severity: "error" | "warn" | "info";
  clientId: string;
  message: string;
  remediation?: string;
};

const FIX =
  "npm run stripe:connect-cutover -- --client-id <app_…> --apply";

export function classifyConnectCutoverFindings(input: {
  clientId: string;
  hasPaidActivePlan: boolean;
  stripeConnectedAccountId: string | null;
  stripeChargesEnabled: boolean;
  connectPaymentsOnly: boolean;
  mappedCustomerCount: number;
}): ConnectCutoverFinding[] {
  const findings: ConnectCutoverFinding[] = [];
  if (input.hasPaidActivePlan && !input.stripeConnectedAccountId) {
    findings.push({
      code: "connect_account_missing",
      severity: "error",
      clientId: input.clientId,
      message: "App has paid plans but no Connected Account",
      remediation:
        "Complete Account Link or OAuth onboarding from Payments settings",
    });
  }
  if (
    input.stripeConnectedAccountId &&
    !input.stripeChargesEnabled &&
    input.hasPaidActivePlan
  ) {
    findings.push({
      code: "connect_charges_disabled",
      severity: "error",
      clientId: input.clientId,
      message: "Connected Account exists but charges_enabled is false",
      remediation: "Refresh Account Link / finish Stripe onboarding",
    });
  }
  if (input.connectPaymentsOnly && input.mappedCustomerCount === 0) {
    findings.push({
      code: "connect_cutover_no_mappings",
      severity: "warn",
      clientId: input.clientId,
      message: "connectPaymentsOnly is set but no merchant customer mappings exist",
      remediation: FIX,
    });
  }
  if (
    input.connectPaymentsOnly &&
    (!input.stripeConnectedAccountId || !input.stripeChargesEnabled)
  ) {
    findings.push({
      code: "connect_payments_only_not_ready",
      severity: "error",
      clientId: input.clientId,
      message: "connectPaymentsOnly is set but Connect is not payment-ready",
      remediation: FIX,
    });
  }
  return findings;
}
