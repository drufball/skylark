-- The canvas rides chat membership, exactly like chat_messages (0007),
-- chat_schedules (0027) and chat_widgets (0031). A canvas page is a piece of the
-- conversation — a chat and nothing else owns one — so its access IS the
-- conversation's access, deferring to `app_can_see_chat` (0007's SECURITY
-- DEFINER wrapper) so the "is the actor in this chat?" predicate keeps one home.
--
-- Like every RLS policy this is hand-written here, not modeled in the drizzle
-- schema, so `db:generate` neither emits nor drifts it (see 0007's note).
alter table "chat_canvas_pages" enable row level security;
--> statement-breakpoint
alter table "chat_canvas_pages" force row level security;
--> statement-breakpoint
create policy "chat_canvas_pages_select" on "chat_canvas_pages" for select using (
  app_can_see_chat("chat_canvas_pages".chat_id));
--> statement-breakpoint
create policy "chat_canvas_pages_insert" on "chat_canvas_pages" for insert with check (
  app_can_see_chat("chat_canvas_pages".chat_id));
--> statement-breakpoint
create policy "chat_canvas_pages_update" on "chat_canvas_pages" for update using (
  app_can_see_chat("chat_canvas_pages".chat_id));
--> statement-breakpoint
create policy "chat_canvas_pages_delete" on "chat_canvas_pages" for delete using (
  app_can_see_chat("chat_canvas_pages".chat_id));
--> statement-breakpoint

-- --- chat_view_state: which page YOU have open --------------------------------
--
-- Membership is the outer gate, as everywhere in chat — but this table gets a
-- second, tighter clause: `user_id = the acting user`. Which page you are
-- looking at is a property of the PERSON, not of the conversation, so three
-- members of one chat hold three independent rows and none of them may read or
-- write another's.
--
-- The write half is the load-bearing one. An agent is a crew member with its own
-- actor, and "an agent moved my view without asking" is precisely the failure
-- this slice refuses to make possible; the policy makes it impossible rather than
-- leaving it to a door remembering. The read half costs nothing and keeps a
-- member's attention from being ambient gossip — the orchestrator reads these
-- rows on the superuser connection to brief an agent about the person it is
-- answering, which is a different thing from members watching each other.
alter table "chat_view_state" enable row level security;
--> statement-breakpoint
alter table "chat_view_state" force row level security;
--> statement-breakpoint
create policy "chat_view_state_select" on "chat_view_state" for select using (
  app_can_see_chat("chat_view_state".chat_id)
  and "chat_view_state".user_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "chat_view_state_insert" on "chat_view_state" for insert with check (
  app_can_see_chat("chat_view_state".chat_id)
  and "chat_view_state".user_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "chat_view_state_update" on "chat_view_state" for update using (
  app_can_see_chat("chat_view_state".chat_id)
  and "chat_view_state".user_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "chat_view_state_delete" on "chat_view_state" for delete using (
  app_can_see_chat("chat_view_state".chat_id)
  and "chat_view_state".user_id = current_setting('app.actor', true));
