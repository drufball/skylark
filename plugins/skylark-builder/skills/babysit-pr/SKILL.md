---
name: babysit-pr
description:
  Use whenever an open PR needs shepherding to a merge — watching CI, weighing
  the agentic reviews, resolving merge conflicts, and merging once everything is
  green. Assumes the PR already exists (code is written, pushed, and `gh pr
  create` has run); this skill starts from there. Used by the `build-feature`
  skill's last step, and by any agent (e.g. a dedicated babysitter) whose job is
  watching a PR through to landing.
---

# Babysitting a PR to a merge

Picks up once a PR is open on a branch you're checked out on (`gh pr view`,
`gh pr checks` show it). A PR isn't done until it's green **and merged** — don't
stop at "CI is running" or "looks good so far."

## 1. Watch the PR settle

CI is more than the test suite — every PR also draws **agentic reviews** (an
architecture review, a mutation review), and these take **minutes**, not
seconds.

Don't block the session waiting, and don't tight-poll. Kick off a watch **in the
background** — it exits when the checks settle and notifies you, so you can keep
working meanwhile:

```
gh pr checks <pr> --watch --interval 30   # run in the background; resolves when all checks finish
gh run watch <run-id> --interval 20 --exit-status   # watch one run; nonzero exit if it fails
gh pr view <pr> --comments                # read the review comments when it's done
```

Only use `gh pr view`/`gh pr checks` for a quick one-off status peek — for
anything longer than a few seconds, background the watch rather than polling in
the foreground.

## 2. Close the loop on everything red or unresolved

- **CI failures** — reproduce locally (`npm run check`, the coverage/mutation
  commands), fix, push. Each push re-runs the gates.
- **Review comments** — the architecture and mutation reviews are advisory, not
  gates: read them, act on what's right, and say why if you skip one. For
  another architecture pass, comment `@architecture-review` on the PR.
- **Merge conflicts** — rebase on the latest `main`
  (`git fetch origin && git rebase origin/main`), resolve, re-run `check`,
  force-push the branch.

If a fix needs real code changes and you're not the one who can write them (e.g.
you're a dedicated babysitter agent with read+bash only), hand the work back to
whoever built the PR with a precise brief of what to fix, rather than attempting
the change yourself.

## 3. Merge

Once CI is green and the comments are handled, **check the PR is actually
mergeable before you merge** — don't just trust that checks passed. While your
PR was in flight, another PR may have merged first and changed the same files,
leaving yours conflicting:

```
gh pr view <pr> --json mergeStateStatus -q .mergeStateStatus
```

- `CLEAN` (or `UNSTABLE` — failing checks are only the advisory reviews) →
  merge.
- `DIRTY` / `CONFLICTING` → **do not try to merge** (the merge will be refused).
  Rebase onto the latest `main`, resolve, re-run `check`, force-push, then
  re-check `mergeStateStatus` until it's mergeable:

  ```
  git fetch origin && git rebase origin/main   # resolve conflicts, then:
  npm run check && git push --force-with-lease
  ```

- `BEHIND` → update the branch (`git fetch origin && git rebase origin/main`,
  push) so it's on the latest `main`, then merge.
- `BLOCKED` → branch protection or a required check is blocking the merge for a
  reason outside this loop (e.g. a required review). Escalate — this isn't
  something to retry your way out of.

Only once it's mergeable:

```
gh pr merge <pr> --squash --delete-branch
```

If the merge command itself fails, read the error and act on it — never end the
turn silently on a failed merge.

That — a merged PR on a sound `main` — is what "shipped" means.
