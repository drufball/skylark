CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_user_id_topic_pk" PRIMARY KEY("user_id","topic")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "watches_topic_idx" ON "watches" USING btree ("topic");--> statement-breakpoint
-- RLS: both tables are private to their owner (see 0007 for the app_user role
-- + app.actor GUC mechanics; policies are hand-maintained in migrations).
--
-- notifications: an inbox is readable and markable only by its owner. There is
-- deliberately NO insert/delete policy for app_user — inbox rows are written
-- only by the notifications reactor, which runs on the superuser systemDb
-- (fan-out crosses users, which no single actor may do). Default-deny does the
-- enforcing.
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notifications_select" ON "notifications" FOR SELECT USING (
  "notifications".user_id = current_setting('app.actor', true));
--> statement-breakpoint
CREATE POLICY "notifications_update" ON "notifications" FOR UPDATE USING (
  "notifications".user_id = current_setting('app.actor', true));
--> statement-breakpoint
-- watches: you manage only your own subscriptions. (The reactor's auto-watch
-- writes other users' rows via systemDb, above RLS.)
ALTER TABLE "watches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "watches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "watches_select" ON "watches" FOR SELECT USING (
  "watches".user_id = current_setting('app.actor', true));
--> statement-breakpoint
CREATE POLICY "watches_insert" ON "watches" FOR INSERT WITH CHECK (
  "watches".user_id = current_setting('app.actor', true));
--> statement-breakpoint
CREATE POLICY "watches_delete" ON "watches" FOR DELETE USING (
  "watches".user_id = current_setting('app.actor', true));
