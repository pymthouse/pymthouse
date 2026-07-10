async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  const parsed = (await response.json().catch(() => null)) as
    | { error_description?: unknown; error?: unknown }
    | null;

  if (!response.ok) {
    const message = [
      parsed?.error_description,
      parsed?.error,
      `Request failed (${response.status})`,
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    throw new Error(message);
  }

  return parsed ? (parsed as Record<string, unknown>) : {};
}

export async function mintOwnerApiKey(input: {
  clientId: string;
  ownerExternalUserId: string;
}): Promise<Record<string, unknown>> {
  const externalUserId = input.ownerExternalUserId.trim();
  if (!externalUserId) throw new Error("Owner identity is unavailable.");

  await postJson(`/api/v1/apps/${encodeURIComponent(input.clientId)}/users`, {
    externalUserId,
    status: "active",
  });

  return postJson(
    `/api/v1/apps/${encodeURIComponent(input.clientId)}/users/${encodeURIComponent(externalUserId)}/keys`,
    { label: "signing-token" },
  );
}
