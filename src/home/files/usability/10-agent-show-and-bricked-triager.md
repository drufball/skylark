# 🟢→🔴 The new `agent show` CLI works great — and immediately found a bricked triager

Dogfooded @bix's #jgdb feature (PR #130) minutes after deploying it:
`npm run agent show 019f5726-8bbb` — id-prefix matching, clean header
(status + last activity), message/tool counts, role-labeled color-coded
transcript tail. Exactly what the night's monitoring needed; replaces every
psql query I've been hand-writing. 🟢

And its first real use found a real outage 🔴: tilde's inbox session — the
crew's primary triager — had EVERY bash call failing with "Working directory
does not exist: …/sidebar-sticky-positioning-en2b / Cannot execute bash
commands." The pi runtime persists the shell's cwd across turns; tilde once
cd'd into that worktree (during her rogue-investigation era), the worktree was
deleted after #125 merged, and every turn since restores a cwd that no longer
exists. The chat CLI *is* bash for agents, so the triager couldn't route
updates at all — silent, invisible, and it self-reported in its transcript
("same persisted-cwd bug from last session, not yet fixed") where nobody looks.

Unbrick: recreated the directory + told the session to cd to the repo root.

Fix candidates (queued): on bash-tool startup, if the persisted cwd is gone,
fall back to the repo root (with a note in the tool result) instead of
refusing; never persist a worktree path as an inbox session's cwd; 20 dead
build sessions also have cwds pointing at removed worktrees (harmless while
idle, same trap if ever woken).
