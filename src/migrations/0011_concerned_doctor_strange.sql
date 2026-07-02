ALTER TABLE "notifications" ADD COLUMN "event_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_event_key" ON "notifications" USING btree ("user_id","event_id");