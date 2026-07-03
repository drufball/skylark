CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entrypoint_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbooks_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "playbook_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;