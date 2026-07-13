ALTER TABLE "issues" ADD COLUMN "status_line_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "awaiting_background" boolean DEFAULT false NOT NULL;