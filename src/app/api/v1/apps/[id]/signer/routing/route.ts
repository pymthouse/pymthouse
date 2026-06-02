import { NextRequest, NextResponse } from "next/server";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import type { SignerRoutingConfig } from "@/lib/billing/types";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const issuer = getIssuer();
  const signerApiUrl = getClientSignerApiUrl();
  const remoteDmzUrl = process.env.SIGNER_INTERNAL_URL?.trim() || null;
  const identityMode =
    process.env.REMOTE_SIGNER_USAGE_IDENTITY_MODE?.trim() || "trusted_headers";

  const meteringMode: SignerRoutingConfig["meteringMode"] = "platform_ingest";

  const config: SignerRoutingConfig = {
    signerApiUrl,
    remoteDmzUrl,
    jwksUri: `${issuer}/api/v1/oidc/jwks`,
    identityMode,
    meteringMode,
  };

  return NextResponse.json({
    clientId,
    routing: config,
    patterns: {
      hostedFacade: {
        description:
          "Forward end-user Authorization to PymtHouse /api/signer/*; metering runs on successful sign.",
        signerApiUrl,
      },
      platformDirectDmz: {
        description:
          "Mint user JWT via Builder API, sign against DMZ directly, POST usage to /api/v1/apps/{clientId}/usage/signed-tickets.",
        remoteDmzUrl,
        ingestUrl: `${issuer}/api/v1/apps/${clientId}/usage/signed-tickets`,
      },
    },
  });
}
