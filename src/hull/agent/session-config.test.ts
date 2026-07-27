import { describe, expect, it } from 'vitest'

import {
  activeTools,
  resolveSessionOptions,
  type AgentConfig,
} from './session-config'

const chat: AgentConfig = {
  systemPrompt: 'pilot',
  tools: ['read', 'bash'],
  readContextFiles: false,
  useRepoSkills: false,
  extensionPaths: [],
  model: null,
}

const builder: AgentConfig = {
  systemPrompt: 'build',
  tools: null,
  readContextFiles: true,
  useRepoSkills: true,
  extensionPaths: ['src/hull/agent/extensions/build-gates/index.ts'],
  model: null,
}

describe('activeTools', () => {
  it("widens an allowlist with the session's own contributed tools", () => {
    // The bug this exists for: a read+bash chat agent was handed `chat_post`,
    // told about it in its prompt, called it, and got "Tool chat_post not
    // found" — because the config's allowlist filtered out a tool the RUNTIME
    // had just deliberately given that session. Same for `background` on every
    // read+bash agent, the babysitter's whole waiting story included.
    expect(
      activeTools(['read', 'bash'], ['background', 'chat_post', 'chat_widget']),
    ).toEqual(['read', 'bash', 'background', 'chat_post', 'chat_widget'])
  })

  it('leaves "pi defaults" alone — pi activates custom tools alongside them', () => {
    expect(activeTools(null, ['background'])).toBeUndefined()
  })

  it('does not duplicate a name the allowlist already carries', () => {
    expect(activeTools(['read', 'background'], ['background'])).toEqual([
      'read',
      'background',
    ])
  })

  it('is just the allowlist when nothing was contributed', () => {
    expect(activeTools(['read'], [])).toEqual(['read'])
  })
})

describe('resolveSessionOptions', () => {
  it('maps an explicit tool allowlist to `tools`', () => {
    const { session } = resolveSessionOptions(chat, '/repo')
    expect(session.tools).toEqual(['read', 'bash'])
    expect(session.cwd).toBe('/repo')
  })

  it("widens the allowlist with the session's contributed tools", () => {
    const { session } = resolveSessionOptions(chat, '/repo', {}, ['chat_post'])
    expect(session.tools).toEqual(['read', 'bash', 'chat_post'])
  })

  it('maps null tools to no allowlist (pi defaults to full coding tools)', () => {
    const { session } = resolveSessionOptions(builder, '/repo')
    expect(session.tools).toBeUndefined()
    expect(
      resolveSessionOptions(builder, '/repo', {}, ['chat_post']).session.tools,
    ).toBeUndefined()
  })

  it("passes the config's system prompt to the resource loader", () => {
    expect(resolveSessionOptions(chat, '/repo').loader.systemPrompt).toBe(
      'pilot',
    )
  })

  it('sets noContextFiles when the config does not read CLAUDE.md', () => {
    expect(resolveSessionOptions(chat, '/repo').loader.noContextFiles).toBe(
      true,
    )
    expect(resolveSessionOptions(builder, '/repo').loader.noContextFiles).toBe(
      false,
    )
  })

  it('sets noSkills (and no skill paths) when the config does not use repo skills', () => {
    const { loader } = resolveSessionOptions(chat, '/repo')
    expect(loader.noSkills).toBe(true)
    expect(loader.additionalSkillPaths).toEqual([])
  })

  it('loads repo skill dirs when the config uses them', () => {
    const skillDirs = (cwd: string) => [`${cwd}/.claude/skills`]
    const { loader } = resolveSessionOptions(builder, '/repo', { skillDirs })
    expect(loader.noSkills).toBe(false)
    expect(loader.additionalSkillPaths).toEqual(['/repo/.claude/skills'])
  })

  it('feeds CLAUDE.md as context files only when readContextFiles is true', () => {
    const readContextFiles = (cwd: string) => [
      { path: `${cwd}/CLAUDE.md`, content: 'hi' },
    ]
    const chatCfg = resolveSessionOptions(chat, '/repo', { readContextFiles })
    expect(chatCfg.loader.contextFiles).toEqual([])
    const builderCfg = resolveSessionOptions(builder, '/repo', {
      readContextFiles,
    })
    expect(builderCfg.loader.contextFiles).toEqual([
      { path: '/repo/CLAUDE.md', content: 'hi' },
    ])
  })

  it('resolves extension paths against the cwd', () => {
    const { loader } = resolveSessionOptions(builder, '/repo')
    expect(loader.additionalExtensionPaths).toEqual([
      '/repo/src/hull/agent/extensions/build-gates/index.ts',
    ])
  })

  it("passes through a config's model override", () => {
    const withModel = { ...chat, model: 'claude-opus-4-5' }
    expect(resolveSessionOptions(withModel, '/repo').model).toBe(
      'claude-opus-4-5',
    )
  })
})
