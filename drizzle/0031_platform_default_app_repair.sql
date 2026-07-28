-- Repair duplicate platform-default / internal Explorer apps introduced during
-- onboarding rollout. Keep one canonical default, revoke legacy credentials,
-- reassign ownership to an admin when needed, and reassert singleton constraints.

DO $$
DECLARE
  canonical_id text;
  admin_owner_id text;
BEGIN
  -- Prefer an admin-owned flagged row, else any flagged row, else newest
  -- admin-owned internal candidate.
  SELECT d.id
  INTO canonical_id
  FROM developer_apps d
  INNER JOIN users u ON u.id = d.owner_id
  WHERE d.is_platform_default = 1
  ORDER BY
    CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
    d.created_at DESC
  LIMIT 1;

  IF canonical_id IS NULL THEN
    SELECT d.id
    INTO canonical_id
    FROM developer_apps d
    INNER JOIN users u ON u.id = d.owner_id
    WHERE u.role = 'admin'
      AND d.name IN ('PymtHouse App', 'PymtHouse Network')
    ORDER BY
      CASE d.name
        WHEN 'PymtHouse App' THEN 0
        WHEN 'PymtHouse Network' THEN 1
        ELSE 2
      END,
      d.created_at DESC
    LIMIT 1;
  END IF;

  SELECT u.id
  INTO admin_owner_id
  FROM users u
  WHERE u.role = 'admin'
  ORDER BY u.created_at ASC
  LIMIT 1;

  IF canonical_id IS NOT NULL THEN
    -- Revoke keys on non-canonical internal candidates and demote them.
    UPDATE api_keys k
    SET
      status = 'revoked',
      revoked_at = COALESCE(k.revoked_at, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    FROM developer_apps d
    INNER JOIN users u ON u.id = d.owner_id
    WHERE k.client_id = d.id
      AND d.id <> canonical_id
      AND u.role = 'admin'
      AND d.name IN ('PymtHouse App', 'PymtHouse Network')
      AND (k.status = 'active' OR k.revoked_at IS NULL);

    UPDATE developer_apps d
    SET
      is_platform_default = 0,
      published_at = NULL,
      marketplace_featured = 0,
      updated_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM users u
    WHERE d.owner_id = u.id
      AND d.id <> canonical_id
      AND u.role = 'admin'
      AND d.name IN ('PymtHouse App', 'PymtHouse Network');

    UPDATE developer_apps
    SET
      is_platform_default = 1,
      published_at = NULL,
      marketplace_featured = 0,
      updated_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHERE id = canonical_id;

    -- Invariant: platform default must be owned by an admin.
    IF admin_owner_id IS NOT NULL THEN
      UPDATE developer_apps d
      SET
        owner_id = admin_owner_id,
        updated_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM users u
      WHERE d.id = canonical_id
        AND d.owner_id = u.id
        AND u.role <> 'admin';
    END IF;
  END IF;
END $$;--> statement-breakpoint

UPDATE "developer_apps"
SET "is_platform_default" = 0
WHERE "is_platform_default" IS NULL;--> statement-breakpoint

ALTER TABLE "developer_apps"
  ALTER COLUMN "is_platform_default" SET DEFAULT 0;--> statement-breakpoint

ALTER TABLE "developer_apps"
  ALTER COLUMN "is_platform_default" SET NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_developer_apps_platform_default"
  ON "developer_apps" ("is_platform_default")
  WHERE "is_platform_default" = 1;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_developer_apps_is_platform_default'
  ) THEN
    ALTER TABLE "developer_apps"
      ADD CONSTRAINT "chk_developer_apps_is_platform_default"
      CHECK ("is_platform_default" IN (0, 1));
  END IF;
END $$;
