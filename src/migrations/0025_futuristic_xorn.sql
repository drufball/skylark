CREATE TABLE "background_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"command" text NOT NULL,
	"label" text NOT NULL,
	"cwd" text NOT NULL,
	"pid" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;