# 🔴 A broken sweep looked exactly like a quiet one (#p5as)

2026-07-27. #fssz/PR #139 taught the files sweep to push main to origin, so
local main would stop diverging. After it merged, the divergence did not go
away: the serving checkout sat 63 commits ahead of origin for ~25 minutes,
sweeping every 30s, pushing nothing.

Cause: with nothing staged the sweep rebased its unpushed doc commits onto
origin/main. That replayed 56 historical commits, the first of which rewrote
agents/tilde/index.md with pre-#q2zi content — over the version #q2zi had
already repaired on origin. Git refused, the sweep returned 'conflict', and
30s later it attempted the identical doomed rebase. Forever.

Two lessons, and the second is the one that cost the time:

1. The rebase was never needed. Local main was a DESCENDANT of origin/main —
   a plain push would have fast-forwarded. The sweep synced unconditionally
   instead of asking whether it had anything to sync.
2. Nothing reported the failure. live.ts discarded sweep()'s return value, so
   'conflict' was indistinguishable from 'waiting'. A permanently wedged
   sweep presented as a healthy idle one, and only a human diffing against
   origin by hand would ever notice.

A silent retry loop is worse than a crash: a crash gets looked at. The fix
(PR #143) skips the sync when a push suffices, converges on content instead
of replaying history, and — the part that matters here — reports outcomes,
latches after five consecutive failures, and announces files.sweep_wedged on
the ship's log. Now a quiet log means a healthy sweep.

Also: #q2zi repaired captured CLI banner noise in memory files, and it came
straight back (tilde 3 blocks, babysitter 1) because nothing stopped the
write path accepting it. Repairing data without closing the door that let it
in buys you one clean day.