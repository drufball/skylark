CREATE TABLE "home_canvas_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"page_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_canvas_tiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"page_id" text NOT NULL,
	"widget_id" text,
	"chat_id" text,
	"grid_x" integer DEFAULT 0 NOT NULL,
	"grid_y" integer DEFAULT 0 NOT NULL,
	"grid_w" integer DEFAULT 2 NOT NULL,
	"grid_h" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_canvas_tiles_one_target" CHECK (("home_canvas_tiles"."widget_id" is null) <> ("home_canvas_tiles"."chat_id" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "answer_value" text;--> statement-breakpoint
ALTER TABLE "home_canvas_pages" ADD CONSTRAINT "home_canvas_pages_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_canvas_tiles" ADD CONSTRAINT "home_canvas_tiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_canvas_tiles" ADD CONSTRAINT "home_canvas_tiles_page_id_home_canvas_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."home_canvas_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_canvas_tiles" ADD CONSTRAINT "home_canvas_tiles_widget_id_chat_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."chat_widgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_canvas_tiles" ADD CONSTRAINT "home_canvas_tiles_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "home_canvas_pages_owner_idx" ON "home_canvas_pages" USING btree ("owner_id","page_order");--> statement-breakpoint
CREATE INDEX "home_canvas_tiles_page_idx" ON "home_canvas_tiles" USING btree ("page_id","grid_y","grid_x");