# 🟡 Issue branches inherit local main's unpushed commits

Issue worktrees branch from LOCAL main, which accumulates unpushed commits:
agent memory writes (29 tonight) and files-service writes (these usability
docs are git commits on main too — that's what "Staged" means). Result: every
issue branch/PR carries dozens of unrelated commits; PR #123 visibly included
agents/tilde/index.md in its diff, and tonight's #4mna branch starts 30+
commits ahead of origin/main before writing a line of code.

Builders have learned to rebase onto origin/main before landing (it's in
@builder's memory file as a lesson), which papers over it — but every build
pays a rebase tax and risks conflict noise in files it never touched.

Same root cause as 01-merges-dont-deploy: local main is both the serving
checkout AND the write-target for memories/files, but never syncs with origin.
Fix ideas: push local main's memory/file commits regularly (or a bot branch),
or move agent-memory + shared-file storage out of the serving checkout's main
branch entirely.
