-- Apps are live on create; migrate any pre-approval statuses to approved.
UPDATE "developer_apps"
SET
  "status" = 'approved',
  "published_at" = COALESCE("published_at", "updated_at", "created_at"),
  "updated_at" = COALESCE("updated_at", "created_at")
WHERE "status" IN ('draft', 'submitted', 'in_review', 'rejected');

-- Clear obsolete review-queue metadata.
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
