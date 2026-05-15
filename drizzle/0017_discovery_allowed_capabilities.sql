--> statement-breakpoint
ALTER TABLE "developer_apps" ADD COLUMN IF NOT EXISTS "discovery_allowed_capabilities" jsonb;

--> statement-breakpoint
WITH caps AS (
  SELECT DISTINCT pcb.client_id AS client_id, pcb.pipeline, pcb.model_id
  FROM plan_capability_bundles pcb
  INNER JOIN plans p ON p.id = pcb.plan_id AND p.client_id = pcb.client_id
  WHERE p.status = 'active'
)
UPDATE developer_apps da
SET discovery_allowed_capabilities = sub.doc
FROM (
  SELECT
    caps.client_id,
    jsonb_build_object(
      'capabilities',
      COALESCE(
        jsonb_agg(
          jsonb_build_object('pipeline', caps.pipeline, 'modelId', caps.model_id)
          ORDER BY caps.pipeline, caps.model_id
        ),
        '[]'::jsonb
      )
    ) AS doc
  FROM caps
  GROUP BY caps.client_id
) sub
WHERE da.id = sub.client_id;
