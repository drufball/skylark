-- Crew access, part 2: agent sessions inherit visibility from their origin.
--
-- An agent session has no crew column; it's spawned by a chat (its backing
-- agent) or an issue (its builder), and should be visible to whoever can see
-- that parent — or to the crew, for a bare/CLI session. Rather than make every
-- reader re-derive that, the session carries an `origin` label (`chat:<id>` /
-- `issue:<id>` / null) and ONE policy dispatches on it. This is the general
-- shape for "rows whose access is inherited from a heterogeneous parent": label
-- the row, let RLS read the label. The same SECURITY DEFINER membership helper
-- from migration 0007 (`app_can_see_chat`) does the chat case.

-- Can the current actor see a session with this origin? Dispatches on the label;
-- reads the app.actor GUC via app_can_see_chat. SECURITY DEFINER + locked path
-- like the chat helpers, so policies calling it don't recurse into RLS.
create function app_can_see_session(p_origin text)
  returns boolean language sql stable security definer
  set search_path = public as $$
    select case
      when p_origin is null then true                 -- bare/CLI: crew-visible
      when p_origin like 'issue:%' then true           -- the board is public
      when p_origin like 'chat:%' then app_can_see_chat(substr(p_origin, 6))
      else true                                        -- unknown label: crew-visible
    end
  $$;
--> statement-breakpoint
-- The same question for a session by id — used by agent_messages, which carries
-- only a session_id. SECURITY DEFINER so the lookup bypasses agent_sessions' own
-- RLS (no recursion).
create function app_can_see_session_id(p_session text)
  returns boolean language sql stable security definer
  set search_path = public as $$
    select app_can_see_session(
      (select origin from agent_sessions where id = p_session))
  $$;
--> statement-breakpoint
grant execute on function app_can_see_session(text) to app_user;
--> statement-breakpoint
grant execute on function app_can_see_session_id(text) to app_user;
--> statement-breakpoint

-- --- agent_sessions: visible/writable per inherited origin ---------------------
alter table "agent_sessions" enable row level security;
--> statement-breakpoint
alter table "agent_sessions" force row level security;
--> statement-breakpoint
create policy "agent_sessions_select" on "agent_sessions" for select using (
  app_can_see_session(origin));
--> statement-breakpoint
create policy "agent_sessions_insert" on "agent_sessions" for insert with check (
  app_can_see_session(origin));
--> statement-breakpoint
create policy "agent_sessions_update" on "agent_sessions" for update using (
  app_can_see_session(origin));
--> statement-breakpoint

-- --- agent_messages: visible/writable iff you can see the parent session -------
alter table "agent_messages" enable row level security;
--> statement-breakpoint
alter table "agent_messages" force row level security;
--> statement-breakpoint
create policy "agent_messages_select" on "agent_messages" for select using (
  app_can_see_session_id(session_id));
--> statement-breakpoint
create policy "agent_messages_insert" on "agent_messages" for insert with check (
  app_can_see_session_id(session_id));
