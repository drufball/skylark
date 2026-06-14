---
name: architecture-review
description:
  Use when reviewing the architecture & structure of Skylark code — a PR diff,
  the whole codebase, or one module. Hunts duplication, hard-to-test code,
  cleverness, deep nesting, files over 1k lines, weak seams (loose coupling +
  acyclic deps), and chances to do the same work in far fewer lines. Ambitious
  by design — for a crew with a high craft bar.
---

# Architecture review

Be ambitious. This is for a crew with a high craft bar and a willingness to
invest — don't self-censor to let a change land. Propose the refactor you
actually believe in, even when it's bigger than the diff; name the smaller
version too. Boring, straightforward code beats clever code. Every finding gets
`file:line` and a concrete fix.

## What to look for

1. **Duplication.** Same logic or knowledge in two places — name every copy,
   propose the single home. Watch for near-duplicates that want one
   parameterized function.
2. **Hard to test.** Logic welded to I/O, the DB, the network, the clock, or the
   framework. Service logic should be database-agnostic (PGlite) — flag what
   can't be tested without standing up the world, and show the seam that fixes
   it.
3. **Cleverness.** Dense one-liners, metaprogramming, implicit control flow,
   "smart" abstractions. Propose the dumb obvious version.
4. **Deep nesting.** Pyramids of `if`, branches 3+ deep. Propose early returns,
   guard clauses, lookup tables, or a named function.
5. **Files over 1,000 lines.** A smell, not a nit. Propose a split along the
   existing seams, with names that say what each new file does.
6. **Weak seams.** Modules should depend on small, explicit contracts, not reach
   into each other's guts. Prefer downward, tree-like dependencies: they must
   form an acyclic DAG and follow Skylark's one-way rule
   (`home → rigging → hull`; only `src/` crosses decks). A dependency that runs
   upward or cuts sideways usually means several modules want the same thing at
   once — so it rarely has a natural shared child to sink into. Hoist it to a
   shared top-level utility at the top of the deck (e.g. `rigging/lib`) that the
   modules depend on _downward_, rather than leaving a long-range edge. Cut
   cycles by introducing an interface, moving a type down a deck, or routing
   through the ship's log (events) instead of a direct call.
7. **Fewer lines, same power.** Refactors that do the same work in significantly
   less code — a first-class goal. But never trade lines for rigidity: the win
   is less code that's _also_ easier to change (delete duplication, drop
   speculative config, find the one primitive several ad-hoc pieces
   approximate).

## Skylark's grain

- **No scale-brain.** Never raise scale, load, or imaginary-user concerns —
  "this won't scale" is a compliment. Do flag complexity serving users who don't
  exist at the expense of the crew who do.
- **Right deck.** `hull/` is the tiny shared foundation every ship clones,
  `rigging/` the stdlib, `home/` sovereign space. Flag hull bloat loudly, and
  any lower deck reaching up or `home` reaching into the hull's guts.
- **Decoupled services.** A service touches only its own tables and learns of
  others through events, never by reaching into their tables.
- **Crew-scoped by construction.** Every row knows its crew structurally, not by
  a convention someone has to remember.
- **Zine honesty.** Flag code that's drifted from its `zine.md`, or a
  load-bearing decision that lives only in someone's head.

## Scope

When a diff is the starting point, use it as a lens, not a fence: review the
whole codebase for what the change reveals — duplication it could absorb or just
tripled, a seam it makes possible. The best findings often sit in files the
change never touched.
