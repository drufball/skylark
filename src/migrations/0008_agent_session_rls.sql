-- Crew access, part 2: agent sessions inherit visibility from their parent.
--
-- An agent session is spawned by a chat (its backing agent — recorded on
-- chat_members.session_id) or an issue (its builder — issues.session_id), and
-- should be visible to whoever can see that parent, or to the crew for a bare
-- session no one references. Rather than denormalize that into a label every
-- creator must remember to stamp (a second source of truth that drifts), the
-- policy reads the STRUCTURAL relationship that already exists: "does an issue
-- or a chat point at this session?" One source of truth, nothing to backfill,
-- nothing to forget — the same relationship the app layer reads.

-- May the current actor see this session? Joins to the parent relationships,
-- reading the app.actor GUC via app_can_see_chat. SECURITY DEFINER + locked
-- search_path like the 0007 helpers, so it bypasses the parents' own RLS for the
-- lookup and never recurses into agent_sessions.
create function app_can_see_session(p_session text)
  returns boolean language sql stable security definer
  set search_path = public as $$
    select case
      -- An issue's builder session is public (the board is public).
      when exists (select 1 from issues where session_id = p_session) then true
      -- A chat's backing session follows that chat's membership.
      when exists (select 1 from chat_members where session_id = p_session)
        then app_can_see_chat(
          (select chat_id from chat_members
           where session_id = p_session limit 1))
      -- A bare/CLI session no one spawned is visible to the crew.
      else true
    end
  $$;
--> statement-breakpoint
grant execute on function app_can_see_session(text) to app_user;
--> statement-breakpoint

-- --- agent_sessions: visible/writable per the inherited parent -----------------
-- (At creation no parent references the row yet, so the insert check is "crew" —
-- the chat/issue link is set immediately after, in the same server-side flow.)
alter table "agent_sessions" enable row level security;
--> statement-breakpoint
alter table "agent_sessions" force row level security;
--> statement-breakpoint
create policy "agent_sessions_select" on "agent_sessions" for select using (
  app_can_see_session(id));
--> statement-breakpoint
create policy "agent_sessions_insert" on "agent_sessions" for insert with check (
  app_can_see_session(id));
--> statement-breakpoint
create policy "agent_sessions_update" on "agent_sessions" for update using (
  app_can_see_session(id));
--> statement-breakpoint

-- --- agent_messages: visible/writable iff you can see the parent session -------
alter table "agent_messages" enable row level security;
--> statement-breakpoint
alter table "agent_messages" force row level security;
--> statement-breakpoint
create policy "agent_messages_select" on "agent_messages" for select using (
  app_can_see_session(session_id));
--> statement-breakpoint
create policy "agent_messages_insert" on "agent_messages" for insert with check (
  app_can_see_session(session_id));
