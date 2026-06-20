import { describe, expect, it } from 'vitest'

import { resolveSessionOptions, type ResolvedProfile } from './session-config'

const chat: ResolvedProfile = {
  systemPrompt: 'pilot',
  tools: ['read', 'bash'],
  readContextFiles: false,
  useRepoSkills: false,
  extensionPaths: [],
  model: null,
}

const builder: ResolvedProfile = {
  systemPrompt: 'build',
  tools: null,
  readContextFiles: true,
  useRepoSkills: true,
  extensionPaths: ['src/hull/agent/extensions/build-gates/index.ts'],
  model: null,
}

describe('resolveSessionOptions', () => {
  it('maps an explicit tool allowlist to `tools`', () => {
    const { session } = resolveSessionOptions(chat, '/repo')
    expect(session.tools).toEqual(['read', 'bash'])
    expect(session.cwd).toBe('/repo')
  })

  it('maps null tools to no allowlist (pi defaults to full coding tools)', () => {
    const { session } = resolveSessionOptions(builder, '/repo')
    expect(session.tools).toBeUndefined()
  })

  it('passes the profile system prompt to the resource loader', () => {
    expect(resolveSessionOptions(chat, '/repo').loader.systemPrompt).toBe(
      'pilot',
    )
  })

  it('sets noContextFiles when the profile does not read CLAUDE.md', () => {
    expect(resolveSessionOptions(chat, '/repo').loader.noContextFiles).toBe(
      true,
    )
    expect(resolveSessionOptions(builder, '/repo').loader.noContextFiles).toBe(
      false,
    )
  })

  it('sets noSkills (and no skill paths) when the profile does not use repo skills', () => {
    const { loader } = resolveSessionOptions(chat, '/repo')
    expect(loader.noSkills).toBe(true)
    expect(loader.additionalSkillPaths).toEqual([])
  })

  it('loads repo skill dirs when the profile uses them', () => {
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

  it('passes through a profile model override', () => {
    const withModel = { ...chat, model: 'claude-opus-4-5' }
    expect(resolveSessionOptions(withModel, '/repo').model).toBe(
      'claude-opus-4-5',
    )
  })
})
