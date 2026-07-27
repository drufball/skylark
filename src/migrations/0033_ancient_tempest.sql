CREATE TABLE "chat_canvas_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"title" text NOT NULL,
	"page_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_view_state" (
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"page_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_view_state_chat_id_user_id_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "page_id" text;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "grid_x" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "grid_y" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "grid_w" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "grid_h" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_canvas_pages" ADD CONSTRAINT "chat_canvas_pages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_view_state" ADD CONSTRAINT "chat_view_state_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_view_state" ADD CONSTRAINT "chat_view_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_view_state" ADD CONSTRAINT "chat_view_state_page_id_chat_canvas_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."chat_canvas_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_canvas_pages_chat_idx" ON "chat_canvas_pages" USING btree ("chat_id","page_order");--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_page_id_chat_canvas_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."chat_canvas_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_widgets_page_idx" ON "chat_widgets" USING btree ("page_id","grid_y","grid_x");