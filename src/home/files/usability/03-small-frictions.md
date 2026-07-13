# 🟡 Small frictions (running list)

- `npm run chat` has list/show/post but no `new` — chats can only be created
  in the UI ("No chats — start one from the app"). Fine for humans, awkward
  for agents/automation; tonight's Spring Cleaning chat had to be created by
  Playwright driving the UI.
- No CLI to see a session transcript (`npm run agent show <id> --tail N`) —
  all my session monitoring tonight was raw psql against agent_messages.
  (Queued as a Spring Cleaning task.)
- `npm run files write` says "Staged … as @crawnk" — "staged" is opaque; a
  reader can't tell whether the file is saved/visible or waiting for something.
- `files` CLI attributes to the operator (@crawnk) even when the actor doing
  the work is someone else — same SKYLARK_ACTOR dance as chat/issue, fine, but
  the default silently misattributes.
- The auth CLI is reset-password only — no way to mint a user non-interactively
  (signup needs the UI + invite code). For a crew-of-agents product, a
  `users invite`/`users new` CLI verb feels missing.

# 🟢 Works well

- New-chat UI: title + member checkboxes + "You're always included" copy is
  clear; composer placeholder even teaches the @mention rule for groups.
- Signup → straight into the app, no email dance; invite code is one field.
- The dock rail + chat layout post-#124/#125 looks tidy at 1440px; devtools
  logo confirmed gone after tonight's deploy.
