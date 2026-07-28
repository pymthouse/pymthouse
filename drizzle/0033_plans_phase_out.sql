ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "phase_out_at" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "replacement_plan_id" text;
