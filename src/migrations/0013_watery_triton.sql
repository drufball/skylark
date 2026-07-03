-- Owner split + issue sessions, part 1 of 2 (0014 drops issues.session_id).
--
-- ownerId: who answers for an issue, split from author_id so an agent can file
-- work on someone else's behalf. Existing issues are owned by their author —
-- the same default createIssue applies from now on — so the column lands
-- nullable, is backfilled, then tightened to NOT NULL.
--
-- issue_sessions: one session per (issue, agent), replacing the single
-- issues.session_id. The old column is backfilled here (while it still exists)
-- by joining the session's own agent_user_id; a legacy session with no agent
-- identity has no (issue, agent) key and simply isn't carried over — its
-- transcript survives in agent_sessions, and a resume boots a fresh hand.
CREATE TABLE "issue_sessions" (
	"issue_id" text NOT NULL,
	"agent_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_sessions_issue_id_agent_user_id_pk" PRIMARY KEY("issue_id","agent_user_id"),
	CONSTRAINT "issue_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "owner_id" text;--> statement-breakpoint
UPDATE "issues" SET "owner_id" = "author_id";--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
INSERT INTO "issue_sessions" ("issue_id", "agent_user_id", "session_id")
  SELECT i."id", s."agent_user_id", i."session_id"
  FROM "issues" i
  JOIN "agent_sessions" s ON s."id" = i."session_id"
  WHERE i."session_id" IS NOT NULL AND s."agent_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_sessions" ADD CONSTRAINT "issue_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sessions" ADD CONSTRAINT "issue_sessions_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sessions" ADD CONSTRAINT "issue_sessions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
