import { describe, expect, it } from 'vitest'

import { readContextFiles, skillDirs } from './config'

// These read the real repo (tests run from the repo root), so they double as a
// check that the ship's own CLAUDE.md and skill dirs are where we think.

describe('readContextFiles', () => {
  it('returns CLAUDE.md from the repo root', () => {
    const files = readContextFiles(process.cwd())
    expect(files).toHaveLength(1)
    expect(files[0].path).toMatch(/CLAUDE\.md$/)
    expect(files[0].content).toContain('Skylark')
  })

  it('returns nothing when the directory has no CLAUDE.md', () => {
    expect(readContextFiles('/nonexistent-ship')).toEqual([])
  })
})

describe('skillDirs', () => {
  it('finds the ship and service-tree skill directories', () => {
    const dirs = skillDirs(process.cwd())
    expect(dirs.some((d) => d.endsWith('.claude/skills'))).toBe(true)
    expect(dirs.some((d) => d.endsWith('src/.claude/skills'))).toBe(true)
  })

  it('returns nothing for a directory with no skills', () => {
    expect(skillDirs('/nonexistent-ship')).toEqual([])
  })
})
