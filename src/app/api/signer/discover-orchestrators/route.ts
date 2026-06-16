import { deprecatedSignerProxyResponse } from "@/lib/deprecated-signer-api";

export async function GET(): Promise<Response> {
  return deprecatedSignerProxyResponse();
}
