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
  linkMcpCatalogClient,
  listMcpCatalogClientStatuses,
  unlinkMcpCatalogClient,
} from "@/lib/mcp/catalog-grants";
import { resetProvider } from "@/lib/oidc/provider";

test("link and unlink catalog grants independently", async (t) => {
  const userId = await createTestUserWithCleanup(t);
  const defaultApp = await seedDeveloperAppWithClient({
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    resetProvider();
    await cleanupTestApp(defaultApp);
  });

  await withTemporaryPlatformDefault(defaultApp.clientId, async () => {
    const claude = await linkMcpCatalogClient({
      userId,
      catalogClientId: "claude",
    });
    assert.equal(claude.linked, true);
    assert.match(claude.mcpUrl, /\/api\/v1\/mcp$/);

    const hermes = await linkMcpCatalogClient({
      userId,
      catalogClientId: "hermes",
    });
    assert.equal(hermes.linked, true);

    await unlinkMcpCatalogClient({
      userId,
      catalogClientId: "claude",
    });
    const statuses = await listMcpCatalogClientStatuses(userId);
    assert.equal(statuses.find((row) => row.id === "claude")?.linked, false);
    assert.equal(statuses.find((row) => row.id === "hermes")?.linked, true);
  });
});
