import { deriveExternalOriginFromHeaders } from "@/app/api/v1/oidc/[...oidc]/utils";

export type OidcInteractionDetails = {
  uid: string;
  prompt: { name: string; details: Record<string, unknown> };
  params: Record<string, unknown>;
  session?: { accountId?: string };
  clientName?: string;
};

function interactionUrl(origin: string, uid: string): string {
  return `${origin}/api/v1/oidc/interaction/${encodeURIComponent(uid)}`;
}

export async function loadOidcInteractionDetails(
  uid: string,
  requestHeaders: Headers,
): Promise<OidcInteractionDetails | null> {
  const origin = deriveExternalOriginFromHeaders(requestHeaders);
  const res = await fetch(interactionUrl(origin, uid), {
    method: "GET",
    headers: {
      cookie: requestHeaders.get("cookie") ?? "",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as OidcInteractionDetails;
}

export async function completeOidcInteraction(
  uid: string,
  requestHeaders: Headers,
): Promise<string | null> {
  const origin = deriveExternalOriginFromHeaders(requestHeaders);
  const res = await fetch(interactionUrl(origin, uid), {
    method: "POST",
    headers: {
      cookie: requestHeaders.get("cookie") ?? "",
      "content-type": "application/json",
    },
    body: "{}",
    redirect: "manual",
    cache: "no-store",
  });
  if (res.status >= 300 && res.status < 400) {
    return res.headers.get("location");
  }
  return null;
}
