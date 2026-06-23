import { routeEndUserUsageRequest } from "@pymthouse/builder-sdk/usage";
import { buildEndUserUsageRequestConfig } from "@/lib/signer/end-user-usage-handlers";

export async function GET(request: Request): Promise<Response> {
  const response = await routeEndUserUsageRequest(
    request,
    buildEndUserUsageRequestConfig(),
  );
  if (!response) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return response;
}
