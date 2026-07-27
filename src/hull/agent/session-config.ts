import { isAbsolute, join } from 'node:path'

import {
  readContextFiles as defaultReadContextFiles,
  skillDirs as defaultSkillDirs,
} from './repo-context'
import type { AgentConfigInput } from './agent-config'

/**
 * The pure mapping from an agent's config to pi.dev session options. Kept apart
 * from the live `createPiSession` wiring (runtime.ts) so the decision — what
 * tools, which skills, whether to read CLAUDE.md, which extensions — is
 * unit-testable without a network or a real pi session. The runtime resolves a
 * user row's config (and its extension registry rows) into an `AgentConfig`,
 * calls this, then hands the result to `createAgentSession` +
 * `DefaultResourceLoader`.
 */

/**
 * An agent's config as the runtime resolves it for booting a session: the
 * stored `AgentConfigInput` with the extension *ids* already turned into
 * repo-relative `extensionPaths`. Derived from `AgentConfigInput` so the
 * config shape has one home — add a knob there and the runtime's mapping
 * fails to compile until it's threaded through here.
 */
export type AgentConfig = Omit<AgentConfigInput, 'extensionIds'> & {
  /** Repo-relative paths to the config's extension modules, in load order. */
  extensionPaths: string[]
}

/** What the live factory needs to build a pi session — framework-shaped, pure. */
export interface SessionOptions {
  /** Options for createAgentSession. */
  session: {
    /** Tool allowlist; undefined means pi enables the default coding tools. */
    tools: string[] | undefined
    /** Working directory the session's tools operate in. */
    cwd: string
  }
  /** Options for DefaultResourceLoader. */
  loader: {
    cwd: string
    systemPrompt: string | null
    /** True → don't feed CLAUDE.md / project context files. */
    noContextFiles: boolean
    /** True → don't load skills. */
    noSkills: boolean
    /** Skill directories to load when noSkills is false. */
    additionalSkillPaths: string[]
    /** Absolute paths to extension modules to load. */
    additionalExtensionPaths: string[]
    /** Context files (CLAUDE.md) to feed, when readContextFiles is true. */
    contextFiles: { path: string; content: string }[]
  }
  /** Model id override, or null to use the session/default model. */
  model: string | null
}

/** Injectable config readers, so the mapping is testable without the filesystem. */
export interface SessionConfigDeps {
  skillDirs: (cwd: string) => string[]
  readContextFiles: (cwd: string) => { path: string; content: string }[]
}

const defaultDeps: SessionConfigDeps = {
  skillDirs: defaultSkillDirs,
  readContextFiles: defaultReadContextFiles,
}

/** Resolve a repo-relative path against the cwd (absolute paths pass through). */
function resolveAgainst(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}

/**
 * The session's active tool set: the config's allowlist PLUS the tools this
 * session was given by the runtime (`background`, and chat's `chat_post` /
 * `chat_widget`). `null` means "pi's defaults", and pi activates custom tools
 * alongside them, so there's nothing to add.
 *
 * The allowlist and contributed tools answer different questions, and conflating
 * them fails silently in the worst way. `tools` is a config field a human wrote
 * to say **which of the ship's abilities this agent may use** — the chat pilot
 * gets `['read','bash']` so it can operate the ship but never modify it. A
 * contributed tool isn't an ability the config was weighing: it's the door the
 * RUNTIME just handed this particular session, on purpose, a moment ago.
 * Filtering it out means pi registers the tool, the model is told about it in the
 * prompt, calls it — and gets back "Tool chat_post not found". Which is exactly
 * what happened the first time a real `read+bash` chat agent tried to speak: it
 * fell back to shelling out to the chat CLI and then told the crew, in the chat,
 * that it had no such tool. (Same bug had `background` inert for every read+bash
 * agent — the babysitter's whole waiting story — so this fixes that too.)
 */
export function activeTools(
  allowlist: string[] | null,
  contributed: string[],
): string[] | undefined {
  if (allowlist === null) return undefined
  return [...new Set([...allowlist, ...contributed])]
}

/**
 * Map a resolved agent config + working directory to pi.dev session options.
 *
 * - `tools` allowlist → `tools`, widened by the session's contributed tool names
 *   (see `activeTools`); null → undefined (pi's default coding tools).
 * - `readContextFiles===false` → `noContextFiles: true` and no context files;
 *   true → CLAUDE.md fed as context files.
 * - `useRepoSkills===false` → `noSkills: true` and no skill paths; true →
 *   the repo's skill dirs.
 * - `extensionPaths` → absolute `additionalExtensionPaths`.
 * - `systemPrompt`, `model` → passed through.
 */
export function resolveSessionOptions(
  config: AgentConfig,
  cwd: string,
  deps: Partial<SessionConfigDeps> = {},
  /** Names of the tools the runtime is registering on this session. */
  contributedTools: string[] = [],
): SessionOptions {
  const { skillDirs, readContextFiles } = { ...defaultDeps, ...deps }
  return {
    session: {
      tools: activeTools(config.tools, contributedTools),
      cwd,
    },
    loader: {
      cwd,
      systemPrompt: config.systemPrompt,
      noContextFiles: !config.readContextFiles,
      noSkills: !config.useRepoSkills,
      additionalSkillPaths: config.useRepoSkills ? skillDirs(cwd) : [],
      additionalExtensionPaths: config.extensionPaths.map((p) =>
        resolveAgainst(cwd, p),
      ),
      contextFiles: config.readContextFiles ? readContextFiles(cwd) : [],
    },
    model: config.model,
  }
}
