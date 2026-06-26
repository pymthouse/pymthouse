import { NextRequest, NextResponse } from "next/server";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import type { SignerRoutingConfig } from "@/lib/billing/types";
import { getIssuer, getPublicOrigin } from "@/lib/oidc/issuer-urls";
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
  const origin = getPublicOrigin();
  const signerApiUrl = getClientSignerApiUrl();
  const remoteDmzUrl = signerApiUrl;
  const identityMode = "webhook";
  const meteringMode: SignerRoutingConfig["meteringMode"] = "platform_ingest";

  const config: SignerRoutingConfig = {
    signerApiUrl,
    remoteDmzUrl,
    jwksUri: `${issuer}/jwks`,
    identityMode,
    meteringMode,
  };

  return NextResponse.json({
    clientId,
    routing: config,
    patterns: {
      directDmz: {
        description:
          "Mint a user JWT via Builder API OIDC, sign against the remote signer DMZ directly with @pymthouse/builder-sdk/signer/server. Identity is verified via the remote-signer webhook; metering flows through Kafka and the OpenMeter collector.",
        signerApiUrl,
        webhookUrl: `${origin}/webhooks/remote-signer`,
      },
    },
  });
}
