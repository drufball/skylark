---
name: author-zine
description:
  Use when writing or updating a zine — Skylark's spec format. Covers the
  required sections (tl;dr, Components, Structure, Decisions, Changelog) and the
  principles for what belongs in a zine versus a skill or elsewhere.
---

# Authoring a zine

A zine is a short, readable spec: enough to rebuild something that works the
same way, not a pixel-perfect clone. It should be a genuine pleasure to read.

## Where zines live, and who gets one

A zine is `zine.md` at the root of whatever it describes. Graduate to a `zine/`
folder only once it has multiple issues. **Hull and rigging components get
zines**; **services get one only if they're meant to be shared**; **home is
zine-optional.**

## The five sections

Every zine uses these, in order:

- **tl;dr** — a couple of paragraphs to orient the reader. No more.
- **Components** — the key terms, parts, and concepts. Define the nouns.
- **Structure** — how the major pieces interact: import direction, data flow.
- **Decisions** — opinionated choices and non-goals (see the rule below).
- **Changelog** — issue number + a one-line synopsis of what changed.

## Principles

1. **Describe what _is_.** In tl;dr, Components, and Structure, state how things
   work, flatly. "It's a TanStack Start app" is enough to rebuild — don't
   justify it against alternatives.

2. **Decisions are forward-guards only.** Include a decision **only if stating
   it prevents a future mistake on the same principle.** A choice nobody will
   revisit (which framework, which test runner) is description, not a decision.
   Reserve this section for the principles future work keeps bumping into.

3. **One source of truth, then link.** Each fact lives in exactly one place;
   everywhere else links to it. **Links point downward** in the hierarchy — a
   parent zine links down to a child's zine for the child's details; a child
   does not link up to restate the parent. Ship-wide facts live in the top zine;
   deck- and service-specific facts live in theirs.

4. **How-tos are skills, not zines.** A zine says what is and why. If you're
   writing steps — "first do X, then Y" — that's a workflow; put it in a skill
   and reference it. (Creating a service is the **create-service** skill, not
   zine prose.)
