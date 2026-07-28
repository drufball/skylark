-- The seeded marker is home-canvas state, so it keeps the home canvas's one
-- rule and nothing else: the row is yours if `owner_id` is you (see 0036 for
-- the whole argument — no join, no membership wrapper, no SECURITY DEFINER
-- helper, because home is personal).
--
-- Why it needs a policy at all: the rooms seed writes it while running as the
-- crew member whose home it is, over the app connection, the same way it pins
-- their tiles. Without RLS enabled the table would be the one row on this deck
-- an actor could read about somebody else — which is not much of a leak, and is
-- exactly the kind of "not much" that becomes a habit.
--
-- No UPDATE policy: the row records THAT the seed ran, never when it last ran,
-- so nothing updates it. A second mark is an insert that conflicts and is
-- dropped (`onConflictDoNothing`), which needs select + insert only.
--
-- Like every RLS policy this is hand-written here, not modeled in the drizzle
-- schema, so `db:generate` neither emits nor drifts it (see 0007's note).
alter table "home_canvas_seeds" enable row level security;
--> statement-breakpoint
alter table "home_canvas_seeds" force row level security;
--> statement-breakpoint
create policy "home_canvas_seeds_select" on "home_canvas_seeds" for select using (
  "home_canvas_seeds".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_seeds_insert" on "home_canvas_seeds" for insert with check (
  "home_canvas_seeds".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_seeds_delete" on "home_canvas_seeds" for delete using (
  "home_canvas_seeds".owner_id = current_setting('app.actor', true));
