ALTER TABLE "issues" DROP CONSTRAINT "issues_origin_chat_id_chats_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "origin_chat_id";