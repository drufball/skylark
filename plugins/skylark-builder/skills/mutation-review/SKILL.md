---
name: mutation-review
description:
  Use when reviewing a PR's test quality via mutation testing. Runs Stryker on
  the diff, triages surviving mutants, and posts findings as a PR comment with
  inline annotations on changed lines.
---

# Mutation review

Review a pull request's test quality by running mutation testing on the changed
files and triaging the survivors.

## Inputs

The workflow sets these environment variables before launching the skill:

- **`PR`** — the pull request number
- **`REPO`** — the repository as `owner/name`

## Workflow

1. Run `npm install` to bootstrap the project.
2. Run `npm run mutate:diff` to mutation-test the files changed by this PR. A
   non-zero exit is expected when mutants survive — do not treat it as failure.
3. Read `reports/mutation/mutation.json`. If the file does not exist, the PR
   changed no mutatable source — post nothing and stop.
4. Inspect mutants with status `Survived` and `NoCoverage`. For each one,
   decide:
   - **Ignore** equivalent mutants, cosmetic mutants, and any where a test would
     add noise not safety.
   - **Keep** survivors that represent a real, plausible bug that could ship
     untested.
5. Post exactly **one** top-level PR comment starting with
   `<!-- mutation-review -->`. Include the diff mutation score, a markdown table
   of survivors worth attention (columns: location `file:line`, the mutation,
   why it matters / the assertion that would kill it), and a closing line:
   "Advisory only — not a merge gate. Comment `@mutation-review` to run this
   again." If every mutant was killed, post a one-line comment with the marker,
   the score, and a nod that the tests held.
6. For survivors on lines **this PR actually changed** (check with
   `git diff --merge-base origin/main`), post inline review comments at the
   exact `file:line` — up to 5, highest value first — naming the assertion that
   would kill the mutant. Survivors on unchanged lines go in the top-level table
   only.

Use `gh` CLI for all GitHub interactions. The head commit is
`git rev-parse HEAD`.

- Top-level: `gh pr comment "$PR" --body-file <file>`
- Inline:
  `gh api repos/$REPO/pulls/$PR/comments -f body=... -f commit_id=<sha> -f path=<file> -F line=<n> -f side=RIGHT`

Do exactly one pass. Do not edit code. Do not re-run mutation testing.
