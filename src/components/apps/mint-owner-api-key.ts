async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};

  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const message =
      (typeof parsed.error_description === "string" && parsed.error_description) ||
      (typeof parsed.error === "string" && parsed.error) ||
      text ||
      `Request failed (${response.status})`;
    throw new Error(message);
  }

  return parsed;
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
