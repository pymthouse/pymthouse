import { deprecatedSignedTicketHttpIngestResponse } from "@/lib/deprecated-signer-api";

export async function POST(): Promise<Response> {
  return deprecatedSignedTicketHttpIngestResponse();
}
