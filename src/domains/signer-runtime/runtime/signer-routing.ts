import { getDefaultSigner, resolveDeveloperAppIdFromAuthAppId } from "../repo/signer-routing";

export async function getSignerRoutingContext(authAppId?: string | null) {
  const signer = await getDefaultSigner();
  const providerAppId = await resolveDeveloperAppIdFromAuthAppId(authAppId);
  return { signer, providerAppId };
}
