# 🟡 Builder tool calls have no timeout — one `find /` hung a build 25 min

@bix's #jgdb builder ran `find / -path /proc -prune -o -iname "*pi-codi*"` to
locate the pi-coding-agent package — a filesystem-wide scan that sat 25
minutes at 0% CPU (special mounts). The session showed 'running'
the whole time (the new #4mna indicator correctly showed busy + the command —
which is exactly how I spotted it). Night watch killed the process; the turn
returned and the build continued.

Suggestions: a per-tool-call wall-clock budget (kill + return partial output
+ a hint), and/or bash guidance in the builder prompt (search node_modules/
package.json before scanning the world).
