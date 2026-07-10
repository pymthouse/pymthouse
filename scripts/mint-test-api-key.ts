/**
 * One-shot: mint a composite app API key for local signer payment probes.
 *
 *   npx tsx scripts/mint-test-api-key.ts [appId]
 */
import "./load-env-first";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import {
  apiKeys,
  appUsers,
  developerApps,
  oidcClients,
} from "../src/db/schema";
import { createAppUserApiKey } from "../src/lib/app-api-keys";

async function main() {
  const appId = process.argv[2] || "app_bf4a4dd275594713afe37052";
  const [app] = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  if (!app) {
    throw new Error(`developer app not found: ${appId}`);
  }

  let publicClientId = appId;
  if (app.oidcClientId) {
    const [oc] = await db
      .select()
      .from(oidcClients)
      .where(eq(oidcClients.id, app.oidcClientId))
      .limit(1);
    if (oc?.clientId) {
      publicClientId = oc.clientId;
    }
  }

  const users = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.clientId, appId))
    .limit(5);
  if (!users.length) {
    throw new Error(`no app_users for ${appId}`);
  }
  const appUser = users[0];

  const created = await createAppUserApiKey({
    developerAppId: appId,
    appUserId: appUser.id,
    publicClientId,
    label: "local-byoc-probe",
  });

  console.log(JSON.stringify({
    appId,
    publicClientId,
    appUserId: appUser.id,
    apiKeyId: created.id,
    apiKey: created.apiKey,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
