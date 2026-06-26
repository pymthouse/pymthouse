const DEPRECATION_HEADERS = {
  "Content-Type": "application/json",
  Deprecation: "true",
} as const;

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
