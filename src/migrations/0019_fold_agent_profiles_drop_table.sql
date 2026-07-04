ALTER TABLE "agent_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- CASCADE already drops agent_sessions' FK to this table — no separate
-- DROP CONSTRAINT needed (and it would fail: the constraint is already gone).
DROP TABLE "agent_profiles" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "profile_id";