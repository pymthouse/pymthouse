-- Display / OpenMeter name for the shared Owner Starter platform plan.
-- NULL means fall back to OWNER_STARTER_PLAN_NAME ("Owner Sandbox Starter").
ALTER TABLE "platform_billing_settings"
  ADD COLUMN IF NOT EXISTS "owner_starter_plan_name" text;
