CREATE TABLE "chat_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"fire_at" timestamp with time zone,
	"interval_minutes" integer,
	"next_fire_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_schedules" ADD CONSTRAINT "chat_schedules_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_schedules" ADD CONSTRAINT "chat_schedules_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_schedules" ADD CONSTRAINT "chat_schedules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_schedules_chat_idx" ON "chat_schedules" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chat_schedules_due_idx" ON "chat_schedules" USING btree ("enabled","fire_at","next_fire_at");