-- Chat widgets ride chat membership, exactly like chat_messages (migration
-- 0007) and chat_schedules (0027). A widget instance is a piece of the
-- conversation, so its access IS the conversation's access: every member of the
-- chat sees it and may answer, dismiss or reorder it, and a non-member sees
-- nothing at all — by construction, not by a door remembering to check.
--
-- Same shape as the other chat-scoped tables, deferring to `app_can_see_chat`
-- (0007's SECURITY DEFINER wrapper over `app_is_chat_member`) so the "is the
-- actor in this chat?" predicate keeps one home.
--
-- Like every RLS policy this is hand-written here, not modeled in the drizzle
-- schema, so `db:generate` neither emits nor drifts it (see 0007's note).
alter table "chat_widgets" enable row level security;
--> statement-breakpoint
alter table "chat_widgets" force row level security;
--> statement-breakpoint
create policy "chat_widgets_select" on "chat_widgets" for select using (
  app_can_see_chat("chat_widgets".chat_id));
--> statement-breakpoint
create policy "chat_widgets_insert" on "chat_widgets" for insert with check (
  app_can_see_chat("chat_widgets".chat_id));
--> statement-breakpoint
create policy "chat_widgets_update" on "chat_widgets" for update using (
  app_can_see_chat("chat_widgets".chat_id));
--> statement-breakpoint
create policy "chat_widgets_delete" on "chat_widgets" for delete using (
  app_can_see_chat("chat_widgets".chat_id));
