-- Lock the door issue_sessions opens. Since 0014, app_can_see_session reads
-- "does an issue point at this session?" from issue_sessions — which makes a
-- row in that table the KEY that flips a session crew-public. Without RLS,
-- 0007's default grants let any actor INSERT a link from any issue id to a
-- PRIVATE chat's backing session and read the transcript. The insert check
-- closes that: you may only link a session you can already see (a fresh,
-- unparented session reads crew-visible, so the orchestrator's create-then-
-- link order still works — and it runs on systemDb regardless). Selects are
-- open: the board is public, and the links carry no content of their own.
alter table "issue_sessions" enable row level security;
--> statement-breakpoint
alter table "issue_sessions" force row level security;
--> statement-breakpoint
create policy "issue_sessions_select" on "issue_sessions" for select using (true);
--> statement-breakpoint
create policy "issue_sessions_insert" on "issue_sessions" for insert with check (
  app_can_see_session(session_id));
