ALTER TABLE "users" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tools" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "read_context_files" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "use_repo_skills" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "extension_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "model" text;--> statement-breakpoint
-- Backfill every user that pointed at a profile with that profile's config,
-- before the next migration drops agent_profiles and users.profile_id.
UPDATE "users" SET
    "system_prompt" = "agent_profiles"."system_prompt",
    "tools" = "agent_profiles"."tools",
    "read_context_files" = "agent_profiles"."read_context_files",
    "use_repo_skills" = "agent_profiles"."use_repo_skills",
    "extension_ids" = "agent_profiles"."extension_ids",
    "model" = "agent_profiles"."model"
FROM "agent_profiles"
WHERE "users"."profile_id" = "agent_profiles"."id";