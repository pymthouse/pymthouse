-- Repair: 0025_auto_approve_developer_apps used journal `when` 1778100000000, but
-- production already had 0025_turnkey_funding_events_repair at 1778500000000, so
-- Drizzle skipped the auto-approve UPDATE (folderMillis must be strictly greater
-- than the latest __drizzle_migrations.created_at). Idempotent.
UPDATE "developer_apps"
SET
  "status" = 'approved',
  "published_at" = COALESCE("published_at", "updated_at", "created_at"),
  "updated_at" = COALESCE("updated_at", "created_at")
WHERE "status" IN ('draft', 'submitted', 'in_review', 'rejected');

UPDATE "developer_apps"
SET
  "submitted_at" = NULL,
  "pending_scopes" = NULL,
  "pending_grant_types" = NULL,
  "pending_revision_submitted_at" = NULL
WHERE
  "submitted_at" IS NOT NULL
  OR "pending_scopes" IS NOT NULL
  OR "pending_grant_types" IS NOT NULL
  OR "pending_revision_submitted_at" IS NOT NULL;

ALTER TABLE "developer_apps" ALTER COLUMN "status" SET DEFAULT 'approved';
