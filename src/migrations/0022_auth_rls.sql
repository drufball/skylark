-- Auth tables are fixed system plumbing, not crew-scoped data: resolving "who
-- is this request?" has to happen BEFORE an actor (and so an RLS context)
-- exists, so credentials/sessions are read and written only via `systemDb`
-- (auth/service.ts, called from auth/server.ts and users/actor.ts) — the same
-- category as seeding, never a door or an LLM-driven path.
--
-- Enabling RLS with NO policies denies app_user every row unconditionally
-- (not even its own), same mechanism as chat's policies (migration 0007) but
-- with the predicate always false instead of a membership check. Belt and
-- suspenders: even a door that mistakenly imported `db` instead of
-- `systemDb` here would see and change nothing, never leak a password hash or
-- forge a session.
alter table "credentials" enable row level security;
--> statement-breakpoint
alter table "credentials" force row level security;
--> statement-breakpoint
alter table "sessions" enable row level security;
--> statement-breakpoint
alter table "sessions" force row level security;
