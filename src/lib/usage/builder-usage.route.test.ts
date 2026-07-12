import assert from "node:assert/strict";

import { run } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterUsageRows,
} from "@/lib/openmeter/usage-read";

run("builder usage API is M2M-only and returns OpenMeter rows", async (t) => {
  const { GET } = await import("@/app/api/v1/builder/apps/[id]/usage/route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const anonymous = await GET(
    new Request(`http://localhost/api/v1/builder/apps/${app.clientId}/usage`),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(anonymous.status, 404);

  __testSetOpenMeterUsageRows(app.clientId, [
    {
      externalUserId: "alpha-ext",
      requestCount: 1,
      networkFeeUsdMicros: "1000",
    },
  ]);
  t.after(() => __testClearOpenMeterUsageStubs());

  const ok = await GET(
    new Request(`http://localhost/api/v1/builder/apps/${app.clientId}/usage`, {
      headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
    }),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { totals: { requestCount: number } };
  assert.equal(body.totals.requestCount, 1);
});
