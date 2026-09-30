/**
 * Consent binding for MCP OAuth: catalog clients always use the platform
 * default app; other DCR clients may still pick an owned Builder app.
 */

import {
  identifyMcpCatalogClient,
  type McpCatalogClientId,
} from "@/lib/mcp/catalog";
import { ensurePlatformDefaultAppUser } from "@/lib/mcp/platform-default-member";
import {
  resolveMcpAppForOwner,
  type OwnedAppChoice,
} from "@/lib/oidc/owned-apps";

export type McpConsentBinding =
  | {
      kind: "catalog";
      catalogClientId: McpCatalogClientId;
      publicClientId: string;
      developerAppId: string;
    }
  | {
      kind: "owned";
      publicClientId: string;
      developerAppId: string;
    };

export async function resolveMcpConsentBinding(input: {
  accountId: string;
  clientId: string;
  redirectUris?: string[] | null;
  clientName?: string | null;
  specifiedAppClientId?: string | null;
  email?: string | null;
}): Promise<
  | { ok: true; binding: McpConsentBinding | null }
  | { ok: false; error: "access_denied"; description: string }
> {
  const catalogClientId = identifyMcpCatalogClient({
    clientId: input.clientId,
    redirectUris: input.redirectUris,
    clientName: input.clientName,
  });

  if (catalogClientId) {
    const member = await ensurePlatformDefaultAppUser({
      userId: input.accountId,
      email: input.email,
    });
    return {
      ok: true,
      binding: {
        kind: "catalog",
        catalogClientId,
        publicClientId: member.clientId,
        developerAppId: member.developerAppId,
      },
    };
  }

  const specified = input.specifiedAppClientId?.trim() || null;
  const owned = await resolveMcpAppForOwner(input.accountId, specified);
  if (specified && !owned) {
    return {
      ok: false,
      error: "access_denied",
      description: "Specified app is not owned by this user",
    };
  }
  if (!owned) {
    return { ok: true, binding: null };
  }
  return {
    ok: true,
    binding: ownedAppToBinding(owned),
  };
}

function ownedAppToBinding(owned: OwnedAppChoice): McpConsentBinding {
  return {
    kind: "owned",
    publicClientId: owned.publicClientId,
    developerAppId: owned.developerAppId,
  };
}

/** True for non-catalog MCP DCR clients that may still pick a Builder app. */
export function mcpConsentRequiresOwnedAppPicker(input: {
  clientId: string;
  redirectUris?: string[] | null;
  clientName?: string | null;
}): boolean {
  return identifyMcpCatalogClient(input) === null;
}
