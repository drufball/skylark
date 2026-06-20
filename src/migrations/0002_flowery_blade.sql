CREATE TABLE "agent_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"system_prompt" text,
	"tools" jsonb,
	"read_context_files" boolean NOT NULL,
	"use_repo_skills" boolean NOT NULL,
	"extension_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extensions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "cwd" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "agent_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;