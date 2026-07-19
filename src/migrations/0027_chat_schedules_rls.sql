-- Chat schedules ride chat membership, exactly like chat_messages (migration
-- 0007). A schedule is visible to — and manageable by — every member of the
-- chat it belongs to, and no one else: no invisible clockwork. Same shape as
-- the other chat-scoped tables, deferring to `app_can_see_chat` so the "is the
-- actor in this chat?" predicate has one home.
--
-- Like every RLS policy this is hand-written here, not modeled in the drizzle
-- schema, so `db:generate` neither emits nor drifts it (see 0007's note). The
-- firing sweep runs on the superuser connection (systemDb), which bypasses RLS
-- — the same posture the chat orchestrator rides.
alter table "chat_schedules" enable row level security;
--> statement-breakpoint
alter table "chat_schedules" force row level security;
--> statement-breakpoint
create policy "chat_schedules_select" on "chat_schedules" for select using (
  app_can_see_chat("chat_schedules".chat_id));
--> statement-breakpoint
create policy "chat_schedules_insert" on "chat_schedules" for insert with check (
  app_can_see_chat("chat_schedules".chat_id));
--> statement-breakpoint
create policy "chat_schedules_update" on "chat_schedules" for update using (
  app_can_see_chat("chat_schedules".chat_id));
--> statement-breakpoint
create policy "chat_schedules_delete" on "chat_schedules" for delete using (
  app_can_see_chat("chat_schedules".chat_id));
