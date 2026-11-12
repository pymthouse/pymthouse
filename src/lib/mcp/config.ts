export function readDiscoveryServiceUrl(): string {
  return (
    process.env.DISCOVERY_SERVICE_URL?.trim() ||
    process.env.DISCOVERY_URL?.trim() ||
    "https://discovery-production-70c1.up.railway.app"
  ).replace(/\/$/, "");
}

export function extractBearerToken(authorization: string | null): string {
  if (!authorization?.trim()) {
    throw new Error("Authorization Bearer token is required");
  }
  const value = authorization.trim();
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
}
