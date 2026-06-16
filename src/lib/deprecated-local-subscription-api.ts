const DEPRECATION_HEADERS = {
  "Content-Type": "application/json",
  Deprecation: "true",
} as const;

export function deprecatedLocalSubscriptionMutationResponse(): Response {
  return Response.json(
    {
      error: "local_subscription_api_deprecated",
      error_description:
        "Local-only /api/v1/subscriptions mutations are removed. Subscription state is authoritative in OpenMeter/Konnect; use app end-user provisioning and Builder billing APIs.",
      migration: {
        provision: "POST /api/v1/apps/{clientId}/users",
        subscription: "GET /api/v1/apps/{clientId}/users/{externalUserId}/subscription",
        allowances: "GET /api/v1/apps/{clientId}/users/{externalUserId}/allowances",
      },
    },
    { status: 410, headers: DEPRECATION_HEADERS },
  );
}

export const LOCAL_SUBSCRIPTION_DEPRECATION_HEADERS = DEPRECATION_HEADERS;
