import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readContextFiles, skillDirs } from './repo-context'

// Hermetic fixtures: a throwaway "ship" on disk, so these test the functions'
// behaviour rather than the real repo's current layout.
let ship: string
let empty: string

beforeAll(() => {
  ship = mkdtempSync(join(tmpdir(), 'skylark-ship-'))
  empty = mkdtempSync(join(tmpdir(), 'skylark-empty-'))
  writeFileSync(join(ship, 'CLAUDE.md'), '# Ship rules\n\nBe kind.\n')
  mkdirSync(join(ship, '.claude/skills'), { recursive: true })
})
afterAll(() => {
  rmSync(ship, { recursive: true, force: true })
  rmSync(empty, { recursive: true, force: true })
})

describe('readContextFiles', () => {
  it('returns CLAUDE.md with its content', () => {
    const files = readContextFiles(ship)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(join(ship, 'CLAUDE.md'))
    expect(files[0].content).toContain('Be kind.')
  })

  it('returns nothing when there is no CLAUDE.md', () => {
    expect(readContextFiles(empty)).toEqual([])
  })
})

describe('skillDirs', () => {
  it('returns only the skill directories that exist', () => {
    // The fixture has .claude/skills but not src/.claude/skills.
    expect(skillDirs(ship)).toEqual([join(ship, '.claude/skills')])
  })

  it('returns nothing when there are no skill directories', () => {
    expect(skillDirs(empty)).toEqual([])
  })
})
