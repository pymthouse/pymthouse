import { and, eq, isNull, ne } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appUsers, developerApps, users } from "@/db/schema";
import {
  createAppUserApiKey,
  formatCompositeApiKey,
} from "@/lib/app-api-keys";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import { createLivepeerPythonSdkToken } from "@/lib/livepeer-python-sdk-token";
import {
  ensurePlatformDefaultApp,
  resolvePlatformDefaultClientId,
} from "@/lib/platform-default-app";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

export type OnboardingPersona = "explorer" | "builder";

export type OnboardingStatus = {
  persona: OnboardingPersona | null;
  onboardingCompletedAt: string | null;
  needsOnboarding: boolean;
  ownsNonDefaultApp: boolean;
  defaultAppClientId: string | null;
};

export async function getUserOnboardingRow(userId: string) {
  const rows = await db
    .select({
      persona: users.persona,
      onboardingCompletedAt: users.onboardingCompletedAt,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function userOwnsNonDefaultApp(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(
      and(eq(developerApps.ownerId, userId), ne(developerApps.isPlatformDefault, 1)),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Developers who have not finished onboarding (and do not already own an app)
 * must complete `/onboarding`. Admins/operators skip. Soft-skipped Builders
 * may use the dashboard with a Complete setup banner.
 */
export async function developerNeedsOnboarding(userId: string): Promise<boolean> {
  const row = await getUserOnboardingRow(userId);
  if (!row) return true;
  if (row.role === "admin" || row.role === "operator") return false;
  if (row.onboardingCompletedAt) return false;
  if (row.persona === "builder") return false;
  if (await userOwnsNonDefaultApp(userId)) {
    // Lazy backfill for pre-wizard users who already own an app.
    await markOnboardingComplete(userId, "builder");
    return false;
  }
  return true;
}

export async function getOnboardingStatus(userId: string): Promise<OnboardingStatus> {
  const needsOnboarding = await developerNeedsOnboarding(userId);
  const row = await getUserOnboardingRow(userId);
  const ownsNonDefaultApp = await userOwnsNonDefaultApp(userId);
  let defaultAppClientId: string | null = null;
  try {
    defaultAppClientId = await resolvePlatformDefaultClientId();
  } catch {
    defaultAppClientId = null;
  }

  const persona =
    row?.persona === "explorer" || row?.persona === "builder" ? row.persona : null;

  return {
    persona,
    onboardingCompletedAt: row?.onboardingCompletedAt ?? null,
    needsOnboarding,
    ownsNonDefaultApp,
    defaultAppClientId,
  };
}

export async function setUserPersona(
  userId: string,
  persona: OnboardingPersona,
): Promise<void> {
  await db
    .update(users)
    .set({ persona })
    .where(eq(users.id, userId));
}

export async function markOnboardingComplete(
  userId: string,
  persona: OnboardingPersona,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(users)
    .set({
      persona,
      onboardingCompletedAt: now,
    })
    .where(and(eq(users.id, userId), isNull(users.onboardingCompletedAt)));
}

export async function softSkipBuilderOnboarding(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      persona: "builder",
      onboardingCompletedAt: null,
    })
    .where(eq(users.id, userId));
}

/**
 * Mint a personal network access key on the platform default app.
 * Available to all developers (Explorer and Builder). Does not clobber a
 * Builder's persona; only completes onboarding as explorer when still needed.
 */
export async function mintDefaultAppNetworkKey(input: {
  userId: string;
  email?: string | null;
  label?: string | null;
}): Promise<{
  clientId: string;
  externalUserId: string;
  apiKey: string;
  keyId: string;
  prefix: string;
  suffix: string;
  label: string | null;
  sdkToken: string | null;
  correlationId: string;
}> {
  const { clientId } = await ensurePlatformDefaultApp();
  const externalUserId = input.userId;
  const now = new Date().toISOString();

  const appRows = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.id, clientId))
    .limit(1);
  const developerAppId = appRows[0]?.id;
  if (!developerAppId) {
    throw new Error("Platform default app is missing");
  }

  const newUser = {
    id: uuidv4(),
    clientId: developerAppId,
    externalUserId,
    email: input.email?.trim() || null,
    status: "active",
    role: "user",
    createdAt: now,
  };

  const upserted = await db
    .insert(appUsers)
    .values(newUser)
    .onConflictDoUpdate({
      target: [appUsers.clientId, appUsers.externalUserId],
      set: {
        status: "active",
        role: "user",
        ...(input.email != null ? { email: input.email.trim() || null } : {}),
      },
    })
    .returning();
  const appUser = upserted[0] ?? newUser;

  try {
    await provisionAppUserBilling({
      clientId: developerAppId,
      externalUserId,
    });
  } catch (err) {
    console.error("Network key billing provision failed:", err);
  }

  const created = await createAppUserApiKey({
    developerAppId,
    appUserId: appUser.id,
    label: input.label?.trim() || "network-signing-token",
  });

  const correlationId = createCorrelationId();
  const row = await getUserOnboardingRow(input.userId);
  const completeAsExplorer =
    !row?.onboardingCompletedAt && row?.persona !== "builder";

  if (completeAsExplorer) {
    await writeAuditLog({
      clientId,
      actorUserId: input.userId,
      action: "onboarding_explorer_joined",
      status: "ok",
      correlationId,
      metadata: { externalUserId, keyId: created.id },
    });
  }

  await writeAuditLog({
    clientId,
    actorUserId: input.userId,
    action: "network_key_minted",
    status: "ok",
    correlationId,
    metadata: { externalUserId, keyId: created.id },
  });

  if (completeAsExplorer) {
    await markOnboardingComplete(input.userId, "explorer");
    await writeAuditLog({
      clientId,
      actorUserId: input.userId,
      action: "onboarding_completed",
      status: "ok",
      correlationId,
      metadata: { persona: "explorer" },
    });
  }

  // Personal apiKey stays bare for usage/self-serve; sdkToken must use the
  // composite presentation so pathless remote-signer webhooks can recover
  // {clientId} and exchange to a JWT (bare pmth_* → 401 "not a JWT").
  let sdkToken: string | null = null;
  try {
    sdkToken = createLivepeerPythonSdkToken({
      apiKey: formatCompositeApiKey(clientId, created.apiKey),
      signer: getClientSignerApiUrl(clientId),
    });
  } catch {
    sdkToken = null;
  }

  return {
    clientId,
    externalUserId,
    apiKey: created.apiKey,
    keyId: created.id,
    prefix: created.prefix,
    suffix: created.suffix,
    label: created.label,
    sdkToken,
    correlationId,
  };
}
