-- The home canvas is PERSONAL, and its policy says so in one line: you may
-- touch a row whose `owner_id` is you, and nothing else. No membership wrapper,
-- no join, no SECURITY DEFINER helper — the whole rule fits in the predicate,
-- which is why `owner_id` is repeated on the tile rather than reached through
-- its page.
--
-- **A pointer is not a grant, and this is the half that makes that true.**
-- Nothing here says whether a tile's CONTENT may be shown: the tile row is
-- yours, so you always see the tile, but what it points AT is read by asking
-- the chat service under this same actor — through chat's own policies
-- (migration 0007's `app_can_see_chat`, 0031's `chat_widgets_*`). So a tile
-- pinned while you were a member of a chat, and read after you were removed,
-- comes back with no content at all. The pin cannot outlive the membership,
-- because the pin was never the thing granting access.
--
-- Like every RLS policy this is hand-written here, not modeled in the drizzle
-- schema, so `db:generate` neither emits nor drifts it (see 0007's note).
alter table "home_canvas_pages" enable row level security;
--> statement-breakpoint
alter table "home_canvas_pages" force row level security;
--> statement-breakpoint
create policy "home_canvas_pages_select" on "home_canvas_pages" for select using (
  "home_canvas_pages".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_pages_insert" on "home_canvas_pages" for insert with check (
  "home_canvas_pages".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_pages_update" on "home_canvas_pages" for update using (
  "home_canvas_pages".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_pages_delete" on "home_canvas_pages" for delete using (
  "home_canvas_pages".owner_id = current_setting('app.actor', true));
--> statement-breakpoint

alter table "home_canvas_tiles" enable row level security;
--> statement-breakpoint
alter table "home_canvas_tiles" force row level security;
--> statement-breakpoint
create policy "home_canvas_tiles_select" on "home_canvas_tiles" for select using (
  "home_canvas_tiles".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_tiles_insert" on "home_canvas_tiles" for insert with check (
  "home_canvas_tiles".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_tiles_update" on "home_canvas_tiles" for update using (
  "home_canvas_tiles".owner_id = current_setting('app.actor', true));
--> statement-breakpoint
create policy "home_canvas_tiles_delete" on "home_canvas_tiles" for delete using (
  "home_canvas_tiles".owner_id = current_setting('app.actor', true));
