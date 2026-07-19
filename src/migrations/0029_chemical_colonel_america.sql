CREATE TABLE "watch_job_checks" (
	"job_id" text PRIMARY KEY NOT NULL,
	"check_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_nudges" (
	"issue_id" text PRIMARY KEY NOT NULL,
	"nudge_count" integer DEFAULT 0 NOT NULL,
	"last_nudge_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ADD COLUMN "check_in_interval_ms" bigint;--> statement-breakpoint
ALTER TABLE "watch_job_checks" ADD CONSTRAINT "watch_job_checks_job_id_background_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."background_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_nudges" ADD CONSTRAINT "watch_nudges_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;