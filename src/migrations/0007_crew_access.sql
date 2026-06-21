-- Crew access, part 1: the access role + chat-membership enforcement in the DB.
--
-- Skylark is single-crew by design: every row in `users` is the crew. Access is
-- therefore intra-crew — a resource is either public or visible to a specific
-- set of users. We enforce that with Postgres Row-Level Security so a service
-- (or a forgotten code path) cannot read rows the actor isn't entitled to: the
-- guarantee is by construction, not by every door remembering to filter.
--
-- The app acts as the non-superuser role `app_user`; `withActor` (hull/db) sets
-- `set local role app_user` + `app.actor` (the acting user id) per request, so
-- every query the door runs is filtered to what that actor may see. RLS is
-- bypassed for the superuser, so migrations and admin/debug still see all rows.
--
-- NOTE: RLS policies live here, in migrations — they are NOT modeled in the
-- drizzle schema, so `db:generate` neither emits nor drifts them. Treat this
-- file as the source of truth for chat access and hand-edit policies in new
-- migrations.

-- The app role. Idempotent so a re-run / fresh worktree / CI is safe.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end
$$;
--> statement-breakpoint
grant usage on schema public to app_user;
--> statement-breakpoint
grant select, insert, update, delete on all tables in schema public to app_user;
--> statement-breakpoint
grant usage, select on all sequences in schema public to app_user;
--> statement-breakpoint
-- Tables/sequences added by later services are reachable without another grant.
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_user;
--> statement-breakpoint
alter default privileges in schema public
  grant usage, select on sequences to app_user;
--> statement-breakpoint

-- Membership checks as SECURITY DEFINER functions: they run as the owner and so
-- bypass RLS on chat_members, which (a) lets a policy ask "is the actor in this
-- chat?" without recursing into chat_members' own policy, and (b) lets the
-- roster of a chat you're in show ALL its members, not just your own row. The
-- locked search_path prevents object-resolution hijacking.
create function app_is_chat_member(p_chat text, p_user text)
  returns boolean language sql stable security definer
  set search_path = public as $$
    select exists (
      select 1 from chat_members where chat_id = p_chat and user_id = p_user)
  $$;
--> statement-breakpoint
create function app_chat_has_members(p_chat text)
  returns boolean language sql stable security definer
  set search_path = public as $$
    select exists (select 1 from chat_members where chat_id = p_chat)
  $$;
--> statement-breakpoint
grant execute on function app_is_chat_member(text, text) to app_user;
--> statement-breakpoint
grant execute on function app_chat_has_members(text) to app_user;
--> statement-breakpoint
-- The actual policy predicate, named once: "may the current actor see this
-- chat?" Reads the app.actor GUC and defers to the membership check, so every
-- chat-scoped policy is `using (app_can_see_chat(<chat id>))` rather than
-- re-typing the GUC read + join — and future chat-scoped tables reuse it.
create function app_can_see_chat(p_chat text)
  returns boolean language sql stable security definer
  set search_path = public as $$
    select app_is_chat_member(p_chat, current_setting('app.actor', true))
  $$;
--> statement-breakpoint
grant execute on function app_can_see_chat(text) to app_user;
--> statement-breakpoint

-- --- chats: a chat is visible only to its members -----------------------------
alter table "chats" enable row level security;
--> statement-breakpoint
alter table "chats" force row level security;
--> statement-breakpoint
create policy "chats_select" on "chats" for select using (
  app_can_see_chat("chats".id));
--> statement-breakpoint
-- A brand-new chat has no members yet; createChat adds them in the same
-- transaction, after which it's only visible to those members.
create policy "chats_insert" on "chats" for insert with check (true);
--> statement-breakpoint
create policy "chats_update" on "chats" for update using (
  app_can_see_chat("chats".id));
--> statement-breakpoint

-- --- chat_members: the roster of a chat you're in -----------------------------
alter table "chat_members" enable row level security;
--> statement-breakpoint
alter table "chat_members" force row level security;
--> statement-breakpoint
create policy "chat_members_select" on "chat_members" for select using (
  app_can_see_chat("chat_members".chat_id));
--> statement-breakpoint
-- You may add members to a chat you're already in; the bootstrap clause lets the
-- creator seed a brand-new (memberless) chat. This blocks the escalation of
-- inserting yourself into someone else's populated chat to read it.
create policy "chat_members_insert" on "chat_members" for insert with check (
  app_can_see_chat("chat_members".chat_id)
  or not app_chat_has_members("chat_members".chat_id));
--> statement-breakpoint
create policy "chat_members_update" on "chat_members" for update using (
  app_can_see_chat("chat_members".chat_id));
--> statement-breakpoint
create policy "chat_members_delete" on "chat_members" for delete using (
  app_can_see_chat("chat_members".chat_id));
--> statement-breakpoint

-- --- chat_messages: read + post only within chats you're in -------------------
alter table "chat_messages" enable row level security;
--> statement-breakpoint
alter table "chat_messages" force row level security;
--> statement-breakpoint
create policy "chat_messages_select" on "chat_messages" for select using (
  app_can_see_chat("chat_messages".chat_id));
--> statement-breakpoint
create policy "chat_messages_insert" on "chat_messages" for insert with check (
  app_can_see_chat("chat_messages".chat_id));
