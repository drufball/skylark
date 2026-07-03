-- Owner split + issue sessions, part 2 of 2: retire issues.session_id.
--
-- app_can_see_session (0008) read the structural relationship "does an issue
-- point at this session?" through that column; the relationship now lives in
-- issue_sessions, so the function is re-pointed FIRST — the visibility rule
-- ("an issue's sessions are public, like the board") is unchanged.
create or replace function app_can_see_session(p_session text)
  returns boolean language sql stable security definer
  set search_path = public as $$
    select case
      -- An issue's agent sessions are public (the board is public).
      when exists (select 1 from issue_sessions where session_id = p_session) then true
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
ALTER TABLE "issues" DROP CONSTRAINT "issues_session_id_agent_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "session_id";
