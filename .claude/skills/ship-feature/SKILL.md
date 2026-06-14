---
name: ship-feature
description:
  Use whenever building or changing a feature in Skylark — the full loop from
  first failing test to a merged PR. Covers red-green TDD, making `npm run
  check` pass, committing on a branch, pushing, opening a PR, shepherding it
  through CI and the agentic reviews, and merging once everything is green.
---

# Shipping a feature

The loop that takes a change from idea to merged. Don't stop early: a feature
isn't shipped until its PR is green and merged. The harness has two gates that
enforce the spine of this loop — the **commit-gate** runs `npm run check` before
any `git add`/`git commit`, and the **landing-gate** won't let you finish with
committed work that isn't pushed and PR'd — so follow the loop and they stay out
of your way.

## 1. Build it red-green

Work **red-green TDD**: write a failing test that pins the behaviour you want,
watch it fail, then write the smallest code that makes it pass. Service logic is
database-agnostic and tests run on in-memory PGlite (`npm test`) — no database
to stand up. Adding a new service? Use the **create-service** skill for the
folder shape and wiring.

## 2. Make the ship sound

Run `npm run check` (format → lint → typecheck → test) until it's clean. This is
the same gate CI runs and the same one the commit-gate runs for you before a
commit — so a clean `check` means the commit will go through. If your change
touches logic, also confirm the lines you added are tested
(`npm run coverage:diff`) and that the tests pin the behaviour
(`npm run mutate:diff`) — these are PR-review questions you'd rather answer
before pushing.

## 3. Commit on a branch

Never commit straight to `main` — work on a branch (a worktree gives you one).
Commit in focused steps with messages that say _why_. The commit-gate runs
`npm run check` first; if it fails it blocks the commit and hands you the errors
— fix them, don't work around the gate.

## 4. Push and open the PR

```
git push -u origin <branch>
gh pr create --fill          # then flesh out the body: what changed and why
```

## 5. Shepherd the PR to green

CI is more than the test suite. On top of `npm run check` and the coverage
gates, every PR draws **agentic reviews** — an architecture review, a mutation
review — and these take **minutes**, not seconds.

Don't block the session waiting, and don't tight-poll. Kick off a watch **in the
background** — it exits when the checks settle and notifies you, so you can keep
working meanwhile:

```
gh pr checks <pr> --watch --interval 30   # run in the background; resolves when all checks finish
gh run watch <run-id> --interval 20 --exit-status   # watch one run; nonzero exit if it fails
gh pr view <pr> --comments                # read the review comments when it's done
```

When the watch returns red, fix and push (each push re-runs the gates), then
start another background watch. Only `gh pr view`/`gh pr checks` for a quick
one-off status peek — for anything longer than a few seconds, background the
watch rather than polling in the foreground.

Then close the loop on everything red or unresolved:

- **CI failures** — reproduce locally (`npm run check`, the coverage/mutation
  commands), fix, push. Each push re-runs the gates.
- **Review comments** — the architecture and mutation reviews are advisory, not
  gates: read them, act on what's right, and say why if you skip one. For
  another architecture pass, comment `@architecture-review` on the PR.
- **Merge conflicts** — rebase on the latest `main`
  (`git fetch origin && git rebase origin/main`), resolve, re-run `check`,
  force-push the branch.

## 6. Merge

Once CI is green and the comments are handled, merge it:

```
gh pr merge <pr> --squash --delete-branch
```

That — a merged PR on a sound `main` — is what "shipped" means.
