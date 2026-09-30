import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createTestUserWithCleanup,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { withTemporaryPlatformDefault } from "@/test-utils/platform-default-lock";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterDashboardUsage,
} from "@/lib/openmeter/usage-read";
import { getBillingUsageDashboardDataForUser } from "@/lib/billing-usage-dashboard-data";
import { PLATFORM_DEFAULT_USAGE_DISPLAY_NAME } from "@/lib/platform-default-labels";
import { mcpConsentRequiresOwnedAppPicker, resolveMcpConsentBinding } from "@/lib/mcp/catalog-consent";

test("catalog consent binds the platform default app and does not require app_client_id", async (t) => {
  const viewer = await createTestUserWithCleanup(t);
  const owned = await seedDeveloperAppWithClient({
    name: `Owned ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(owned);
  });
  const defaultApp = await seedDeveloperAppWithClient({
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(defaultApp);
  });

  await withTemporaryPlatformDefault(defaultApp.clientId, async () => {
    const withoutAppClientId = await resolveMcpConsentBinding({
      accountId: viewer,
      clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      specifiedAppClientId: owned.clientId,
    });
    assert.equal(withoutAppClientId.ok, true);
    if (!withoutAppClientId.ok) return;
    assert.equal(withoutAppClientId.binding?.kind, "catalog");
    if (withoutAppClientId.binding?.kind !== "catalog") return;
    assert.equal(withoutAppClientId.binding.catalogClientId, "claude");
    assert.equal(withoutAppClientId.binding.publicClientId, defaultApp.clientId);
    assert.equal(
      withoutAppClientId.binding.developerAppId,
      defaultApp.clientId,
    );

    assert.equal(
      mcpConsentRequiresOwnedAppPicker({
        clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      }),
      false,
    );
    assert.equal(
      mcpConsentRequiresOwnedAppPicker({
        clientId: "dcr_other",
        redirectUris: ["http://127.0.0.1/callback"],
        clientName: "MCP Connector",
      }),
      true,
    );

    const cursor = await resolveMcpConsentBinding({
      accountId: viewer,
      clientId: "dcr_cursordemo",
      redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      specifiedAppClientId: owned.clientId,
    });
    assert.equal(cursor.ok, true);
    if (cursor.ok) {
      assert.equal(cursor.binding?.kind, "catalog");
      if (cursor.binding?.kind === "catalog") {
        assert.equal(cursor.binding.catalogClientId, "cursor");
        assert.equal(cursor.binding.publicClientId, defaultApp.clientId);
      }
    }

    const otherDcr = await resolveMcpConsentBinding({
      accountId: owned.userId,
      clientId: "dcr_other",
      redirectUris: ["http://127.0.0.1/callback"],
      clientName: "MCP Connector",
      specifiedAppClientId: owned.clientId,
    });
    assert.equal(otherDcr.ok, true);
    if (otherDcr.ok) {
      assert.equal(otherDcr.binding?.kind, "owned");
      if (otherDcr.binding?.kind === "owned") {
        assert.equal(otherDcr.binding.publicClientId, owned.clientId);
      }
    }

    __testSetOpenMeterDashboardUsage(defaultApp.clientId, {
      byUser: [
        {
          externalUserId: viewer,
          requestCount: 3,
          networkFeeUsdMicros: "3000",
        },
      ],
      byPipelineModel: [
        {
          pipeline: "llm",
          modelId: "b",
          requestCount: 3,
          networkFeeUsdMicros: "3000",
        },
      ],
      byUserPipelineModel: [
        {
          externalUserId: viewer,
          pipeline: "llm",
          modelId: "b",
          requestCount: 3,
          networkFeeUsdMicros: "3000",
        },
      ],
      byDailyPipeline: [],
      requestsByDay: new Map([["2026-07-01", 3]]),
    });
    t.after(() => __testClearOpenMeterUsageStubs());

    const dashboard = await getBillingUsageDashboardDataForUser(
      viewer,
      "developer",
      undefined,
      { ownAppsOnly: true },
    );
    assert.equal(dashboard.ok, true);
    if (!dashboard.ok) return;
    const personal = dashboard.data.orderedApps.find(
      (app) => app.usageKind === "personal",
    );
    assert.ok(personal);
    assert.equal(personal.name, PLATFORM_DEFAULT_USAGE_DISPLAY_NAME);
    assert.equal(personal.publicClientId, defaultApp.clientId);
  });
});
