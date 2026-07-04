---
name: build-feature
description:
  Use whenever building or changing a feature in Skylark — the loop from first
  failing test to an open, mergeable PR. Covers red-green TDD, making `npm run
  check` pass, committing on a branch, pushing, and opening a PR. Once the PR is
  open, hand off to the **babysit-pr** skill (or a dedicated babysitter agent)
  to shepherd it through CI, reviews, and the merge — a feature isn't shipped
  until that's done too.
---

# Building a feature

The loop that takes a change from idea to an open PR. The harness has two gates
that enforce the spine of this loop — the **commit-gate** runs `npm run check`
before any `git add`/`git commit`, and the **landing-gate** won't let you finish
with committed work that isn't pushed and PR'd — so follow the loop and they
stay out of your way.

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

## 5. Get it merged — hand off, or babysit it yourself

The PR being open isn't "shipped" — it isn't shipped until it's merged. What
happens next depends on who's running you:

- **Part of a Skylark playbook with a babysitter agent on the roster?** Hand the
  baton to it through the issue CLI as your last action, then stop. It runs the
  **babysit-pr** skill from here — watching CI, weighing reviews, resolving
  conflicts, and merging.
- **Working solo, or no babysitter to hand off to** (e.g. this skill is being
  run outside Skylark by some other tool)? Run the **babysit-pr** skill
  yourself, right now, to take the PR the rest of the way to a merge.

Either way, don't consider the feature done until babysit-pr's job is done — a
merged PR on a sound `main`.
