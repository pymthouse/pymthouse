-- Drop retired per-user auto-top-up prefs. Collection is app soft-negative +
-- OpenMeter progressive invoicing; these columns are unread.
ALTER TABLE "app_users" DROP COLUMN IF EXISTS "auto_top_up_enabled";
ALTER TABLE "app_users" DROP COLUMN IF EXISTS "auto_top_up_usd_micros";
ALTER TABLE "app_users" DROP COLUMN IF EXISTS "auto_top_up_before_soft_negative";
