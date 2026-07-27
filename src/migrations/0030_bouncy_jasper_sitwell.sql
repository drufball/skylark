CREATE TABLE "chat_widgets" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"kind" text NOT NULL,
	"props" jsonb NOT NULL,
	"placement" text DEFAULT 'stack' NOT NULL,
	"stack_order" integer DEFAULT 0 NOT NULL,
	"dismissed_at" timestamp with time zone,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_widgets_chat_idx" ON "chat_widgets" USING btree ("chat_id","placement","stack_order");