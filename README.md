# Skylark ☀️🏴‍☠️

**An operating system for personal software.**

Skylark is a self-hosted home for software that agents build *for you* — you, your friends, your small crew. Clone the repo, run one script on a machine you own, and you've got a ship: a personal server with an agent aboard, a tunnel to the outside world, and a hull ready for whatever you dream up.

> *Skylarking (n.) — age-of-sail slang for unauthorized joy in the rigging.* Sailors got punished for it. We built an OS around it.

## The wrong question

The entire industry is asking the same question: *when will agents be ready to write production software?*

Wrong question. **Production is the problem.** Horizontal scale, zero-downtime deploys, compliance reviews, the edge cases of a million strangers — that's where agents struggle. (Humans too, for what it's worth.)

Nobody stopped to ask what happens if you change the product assumptions and lean into where agents are already great. Do that honestly, and the answer falls out: **agents can build anything you actually need. Today.** Five assumptions have to flip:

### 1. Personal software

You're building for you and your friends, not a market. That deletes most of the difficulty: no scaling, no enterprise threat model, no long tail of users you'll never meet. Ship bugs! Your friends will find them, tell you in the group chat, and the agent fixes them by dinner. **A bug is a conversation, not an incident.**

### 2. No deployment

If it's just your crew, you don't need environments and release pipelines. A dev server on a machine you own, plus a tunnel so friends can log in from any phone. **`npm run dev` is the production server.** "Deploying" stops existing as a concept.

### 3. Agent-first

You don't build An App with nav and settings and forty screens. You start with an API. The agent talks to it directly. When you want to *see* something, the agent codes that one view and pipes the data in. A design system accretes. Full apps eventually emerge — but everything starts as agent + CLI, and **the app grows out of use.**

### 4. Small scale (this is the point)

Skylark is not built to scale, and never will be. It's built to be **cloned**. Everyone gets the whole ship — the repo is the product, and your copy is yours all the way down. Software that scales to your friends.

### 5. You write all your own code

There's a sharing community, but what people share are **zines**, not binaries. (A zine is a tiny spec — a small, readable pamphlet describing a piece of software.) A zine doesn't have to be comprehensive: it holds the parts that should survive a rebuild — the taste, the hard-won decisions, the edge cases that matter — and it should be a genuine pleasure to read. Your agent implements the zine in *your* codebase, customized however you want. And when upstream ships an update, it's literally the next **issue** of the zine — your agent reads it and conforms your code.

And the security model becomes simple and ancient: **the code that runs on your ship was written on your ship.**

## What Skylark gives you

⛵ **Boom, you're hosted.** Clone the repo, run `./hoist` on the machine you want as your host, and you're live — local server, tunnel to the outside world, log in from any phone or laptop. That's the entire deployment story.

🤖 **A first mate.** An agent-first UX from the start: your personal assistant, plus orchestration for tasks and subagents. The agent isn't a feature of Skylark — it's the primary resident.

🧰 **A harness that just works.** A baked-in stack, design system, and skills for creating software, so the agent never bikesheds tech choices. You describe what you want. Not the tech.

⚓ **A crew, natively.** Users are a built-in primitive. Every service you create already knows who's aboard and who can reach it — **every row in every database knows who's allowed to see it.** You never bolt auth on. It's in the water.

📡 **Everything is an event.** Services emit to the ship's log; anything can subscribe. Apps stop being silos and become little hobgoblins spanning services — update a record in one place and the dashboard, the planner, and *your friend's ship across the water* all hear it instantly. (This is the bet we're most excited about and least certain of. Come argue with us onboard.)

🏗 **Services are the native unit.** A CRUD database + backend logic + a CLI to drive it: Skylark mints these in one motion and registers them with the agent immediately. New service, and the agent already speaks it.

🐚 **A tiny hull, and a home that's all yours.** See the shape of the ship below. The ethos: keep `hull/` brutally small and maximally expressive, push everything possible up into the rigging, and leave `home/` as your sovereign weird space.

🏴‍☠️ **A message board, not a ticket queue.** Orchestration is issue-based, but issues feel like threads on the crew's board — proposals, riffs, votes, lore. The agent decomposes work in the background; what you see is your crew designing software together. And of course you'll build your own frontend for the board. Two crews might share the same board service and read it through completely different frontends they each wrote. Your board pulls threads from every crew you sail with — the BBSes did this in 1986 and called it echomail; we're bringing it back.

## The shape of the ship

```
skylark/
├── hull/      # the foundation — tiny, stable, shared by every ship afloat
├── rigging/   # the stdlib — built ON TOP of the hull; carries as much weight as possible
└── home/      # yours — your services, your apps, your experiments, your chaos
```

(We needed a better name than "stdlib." It's the **rigging**: everything built on the hull that makes it actually sail.)

You'll do most of your living in `home/`. You *can* hack the hull — it's your ship — but the deal we make as a community: the hull stays small so it can stay open to everyone, rigging carries the weight, and home is sovereign. Your OS and your apps live in one monorepo, because **the repo is the ship.**

## The crew

Every ship comes crewed. Three reviewers live in [`.claude/agents/`](.claude/agents/) and sail with every clone — hand them any feature or project for an outside opinion:

- **Tilde, the Shipwright** 🔨 — structure & architecture. Walks the hull, checks the joints, scrapes the barnacles, keeps the hull honest.
- **Dot, the Quartermaster** 📰 — crew experience. Editor of the ship's zine; reviews everything by asking what your actual friends will feel when they touch it.
- **Bix, the Lookout** 📡 — edge cases & weather. Old man of the sea in the crow's nest; charts the reefs so you can sail *faster*, not slower.

They're yes-anders with sharp eyes: vision-aligned, allergic to scale-brain, and every concern comes with a fix attached.

## Status

🚧 **Day one.** This README is the charter; the ship is being built in the open. If any of the above made your heart beat faster — welcome aboard.

Fair winds and following seas. ☀️⛵
