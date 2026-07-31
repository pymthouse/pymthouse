/**
 * Force-migrate OpenMeter subscribers from one app plan onto another.
 *
 * Usage:
 *   npm run openmeter:migrate-plan-subscribers -- --client-id app_x --from-plan <planId>
 *   npm run openmeter:migrate-plan-subscribers -- --client-id app_x --from-plan <planId> --to-plan <planId> --apply
 *   npm run openmeter:migrate-plan-subscribers -- --client-id app_x --from-plan <planId> --timing next_billing_cycle --apply
 */
import "./load-env-first";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { closeDb, db } from "../src/db/index";
import { plans, subscriptions } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import { buildOpenMeterCustomerKey } from "../src/lib/openmeter/customer-key";
import {
  changeKonnectSubscription,
  listActiveKonnectSubscriptions,
  parseSubscriptionTiming,
  subscriptionMatchesOpenMeterPlanId,
  type SubscriptionChangeTiming,
} from "../src/lib/openmeter/konnect-subscriptions";
import { takeArgValue } from "./lib/openmeter-konnect-migrate";

type Args = {
  apply: boolean;
  clientId: string;
  fromPlanId: string;
  toPlanId?: string;
  timing: SubscriptionChangeTiming;
  limit?: number;
};

function parseArgs(argv: string[]): Args {
  let apply = false;
  let clientId = "";
  let fromPlanId = "";
  let toPlanId: string | undefined;
  let timing: SubscriptionChangeTiming = "next_billing_cycle";
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--client-id") {
      clientId = takeArgValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--from-plan") {
      fromPlanId = takeArgValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--to-plan") {
      toPlanId = takeArgValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--timing") {
      timing = parseSubscriptionTiming(takeArgValue(argv, i, token));
      i += 1;
      continue;
    }
    if (token === "--limit") {
      limit = Number(takeArgValue(argv, i, token));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!clientId.trim()) {
    throw new Error("--client-id is required");
  }
  if (!fromPlanId.trim()) {
    throw new Error("--from-plan is required");
  }

  return {
    apply,
    clientId: clientId.trim(),
    fromPlanId: fromPlanId.trim(),
    toPlanId: toPlanId?.trim() || undefined,
    timing,
    limit,
  };
}

async function resolveTargetPlan(input: {
  clientId: string;
  fromPlanId: string;
  toPlanId?: string;
}): Promise<typeof plans.$inferSelect> {
  if (input.toPlanId) {
    const rows = await db
      .select()
      .from(plans)
      .where(
        and(eq(plans.id, input.toPlanId), eq(plans.clientId, input.clientId)),
      )
      .limit(1);
    const plan = rows[0];
    if (!plan) {
      throw new Error(`--to-plan ${input.toPlanId} not found for app`);
    }
    if (plan.status === "phase_out") {
      throw new Error("--to-plan cannot be a phase_out plan");
    }
    if (!plan.openmeterPlanId) {
      throw new Error("--to-plan is not synced to OpenMeter");
    }
    return plan;
  }

  const fromRows = await db
    .select()
    .from(plans)
    .where(
      and(eq(plans.id, input.fromPlanId), eq(plans.clientId, input.clientId)),
    )
    .limit(1);
  const fromPlan = fromRows[0];
  if (!fromPlan) {
    throw new Error(`--from-plan ${input.fromPlanId} not found for app`);
  }

  if (fromPlan.replacementPlanId) {
    const replacementRows = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.id, fromPlan.replacementPlanId),
          eq(plans.clientId, input.clientId),
        ),
      )
      .limit(1);
    const replacement = replacementRows[0];
    if (replacement?.openmeterPlanId && replacement.status !== "phase_out") {
      return replacement;
    }
  }

  const starterRows = await db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.clientId, input.clientId),
        eq(plans.isStarterDefault, true),
      ),
    )
    .limit(1);
  const starter = starterRows[0];
  if (!starter?.openmeterPlanId) {
    throw new Error(
      "No --to-plan, usable replacementPlanId, or synced Starter plan available",
    );
  }
  return starter;
}

async function upsertNeonCache(input: {
  clientId: string;
  customerKey: string;
  planId: string;
  openmeterSubscriptionId: string;
}): Promise<void> {
  const externalUserId = input.customerKey.includes(":")
    ? input.customerKey.slice(input.customerKey.indexOf(":") + 1)
    : input.customerKey;
  const existing = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, input.clientId),
        eq(subscriptions.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(subscriptions)
      .set({
        planId: input.planId,
        status: "active",
        openmeterSubscriptionId: input.openmeterSubscriptionId,
        externalUserId,
      })
      .where(eq(subscriptions.id, existing[0].id));
    return;
  }
  await db.insert(subscriptions).values({
    id: uuidv4(),
    userId: null,
    clientId: input.clientId,
    planId: input.planId,
    status: "active",
    openmeterSubscriptionId: input.openmeterSubscriptionId,
    openmeterCustomerKey: input.customerKey,
    externalUserId,
    createdAt: new Date().toISOString(),
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OPENMETER_URL / OPENMETER_API_KEY not configured");
  }

  const fromRows = await db
    .select()
    .from(plans)
    .where(
      and(eq(plans.id, args.fromPlanId), eq(plans.clientId, args.clientId)),
    )
    .limit(1);
  const fromPlan = fromRows[0];
  if (!fromPlan?.openmeterPlanId) {
    throw new Error("--from-plan not found or not synced to OpenMeter");
  }

  const toPlan = await resolveTargetPlan({
    clientId: args.clientId,
    fromPlanId: args.fromPlanId,
    toPlanId: args.toPlanId,
  });

  if (toPlan.id === fromPlan.id) {
    throw new Error("from-plan and to-plan must differ");
  }

  const client = getHostedAdminClient();
  const active = await listActiveKonnectSubscriptions();
  let targets = active.filter((item) =>
    subscriptionMatchesOpenMeterPlanId(item, fromPlan.openmeterPlanId!),
  );
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
    targets = targets.slice(0, Math.max(0, args.limit));
  }

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry-run",
        clientId: args.clientId,
        fromPlanId: fromPlan.id,
        toPlanId: toPlan.id,
        timing: args.timing,
        candidates: targets.length,
      },
      null,
      2,
    ),
  );

  let migrated = 0;
  let failed = 0;

  for (const sub of targets) {
    const customerId = sub.customer_id?.trim() || sub.customerId?.trim() || "";
    if (!customerId) {
      console.error(`skip ${sub.id}: missing customer id`);
      failed += 1;
      continue;
    }

    let customerKey = "";
    try {
      const customer = await client.customers.get(customerId);
      customerKey = customer?.key?.trim() || "";
    } catch (err) {
      console.error(
        `fail ${sub.id}: load customer ${customerId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failed += 1;
      continue;
    }

    if (!args.apply) {
      console.log(
        `dry-run would migrate subscription=${sub.id} customer=${customerId} key=${customerKey || "?"}`,
      );
      migrated += 1;
      continue;
    }

    try {
      const change = await changeKonnectSubscription({
        subscriptionId: sub.id,
        customerId,
        planId: toPlan.openmeterPlanId!,
        timing: args.timing,
      });
      const nextId =
        change.next?.id?.trim() || change.current?.id?.trim() || sub.id;
      if (customerKey) {
        await upsertNeonCache({
          clientId: args.clientId,
          customerKey:
            customerKey.includes(":")
              ? customerKey
              : buildOpenMeterCustomerKey(args.clientId, customerKey),
          planId: toPlan.id,
          openmeterSubscriptionId: nextId,
        });
      }
      console.log(
        `migrated subscription=${sub.id} -> ${nextId} customer=${customerId}`,
      );
      migrated += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `fail ${sub.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    JSON.stringify({ migrated, failed, apply: args.apply }, null, 2),
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
