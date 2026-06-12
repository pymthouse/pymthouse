const DEPRECATION_HEADERS = {
  "Content-Type": "application/json",
  Deprecation: "true",
} as const;

export function deprecatedSignerProxyResponse(): Response {
  return Response.json(
    {
      error: "signer_proxy_deprecated",
      error_description:
        "PymtHouse /api/signer/* signing proxy is removed. Mint a user JWT via the Builder API OIDC token endpoint, sign directly against the remote signer DMZ with @pymthouse/builder-sdk/signer/server, and use /webhooks/remote-signer for identity. Metering is asynchronous via Kafka and the OpenMeter collector.",
      migration: {
        routing: "GET /api/v1/apps/{clientId}/signer/routing",
        webhook: "/webhooks/remote-signer",
        sdk: "@pymthouse/builder-sdk/signer/server",
      },
    },
    { status: 410, headers: DEPRECATION_HEADERS },
  );
}

export function deprecatedSignedTicketHttpIngestResponse(): Response {
  return Response.json(
    {
      error: "signed_ticket_http_ingest_deprecated",
      error_description:
        "Synchronous HTTP signed-ticket ingest is removed. go-livepeer emits create_signed_ticket events to Kafka; the OpenMeter collector writes usage to Konnect.",
      migration: {
        metering: "Kafka topic livepeer-gateway-events → openmeter-collector",
        identity: "/webhooks/remote-signer",
      },
    },
    { status: 410, headers: DEPRECATION_HEADERS },
  );
}
