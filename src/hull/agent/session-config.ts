import { isAbsolute, join } from 'node:path'

import {
  readContextFiles as defaultReadContextFiles,
  skillDirs as defaultSkillDirs,
} from './repo-context'
import type { ProfileInput } from './profiles'

/**
 * The pure mapping from an agent profile to pi.dev session options. Kept apart
 * from the live `createPiSession` wiring (runtime.ts) so the decision — what
 * tools, which skills, whether to read CLAUDE.md, which extensions — is
 * unit-testable without a network or a real pi session. The runtime resolves a
 * profile row (and its extension registry rows) into a `ResolvedProfile`, calls
 * this, then hands the result to `createAgentSession` + `DefaultResourceLoader`.
 */

/**
 * A profile as the runtime resolves it for booting a session: the stored
 * `ProfileInput` minus its identity (`name`) and with the extension *ids*
 * already turned into repo-relative `extensionPaths`. Derived from
 * `ProfileInput` so the profile shape has one home — add a knob there and the
 * runtime's mapping fails to compile until it's threaded through here.
 */
export type ResolvedProfile = Omit<ProfileInput, 'name' | 'extensionIds'> & {
  /** Repo-relative paths to the profile's extension modules, in load order. */
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
 * Map a resolved profile + working directory to pi.dev session options.
 *
 * - `tools` allowlist → `tools`; null → undefined (pi's default coding tools).
 * - `readContextFiles===false` → `noContextFiles: true` and no context files;
 *   true → CLAUDE.md fed as context files.
 * - `useRepoSkills===false` → `noSkills: true` and no skill paths; true →
 *   the repo's skill dirs.
 * - `extensionPaths` → absolute `additionalExtensionPaths`.
 * - `systemPrompt`, `model` → passed through.
 */
export function resolveSessionOptions(
  profile: ResolvedProfile,
  cwd: string,
  deps: Partial<SessionConfigDeps> = {},
): SessionOptions {
  const { skillDirs, readContextFiles } = { ...defaultDeps, ...deps }
  return {
    session: {
      tools: profile.tools ?? undefined,
      cwd,
    },
    loader: {
      cwd,
      systemPrompt: profile.systemPrompt,
      noContextFiles: !profile.readContextFiles,
      noSkills: !profile.useRepoSkills,
      additionalSkillPaths: profile.useRepoSkills ? skillDirs(cwd) : [],
      additionalExtensionPaths: profile.extensionPaths.map((p) =>
        resolveAgainst(cwd, p),
      ),
      contextFiles: profile.readContextFiles ? readContextFiles(cwd) : [],
    },
    model: profile.model,
  }
}
