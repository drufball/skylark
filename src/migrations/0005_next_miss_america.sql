ALTER TABLE "events" ALTER COLUMN "scope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "audience" text;--> statement-breakpoint
CREATE INDEX "events_topic_id_idx" ON "events" USING btree ("topic","id");