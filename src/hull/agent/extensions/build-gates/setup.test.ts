import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { needsSetup, setupLogMessage } from './gates'

describe('worktree setup detection', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `build-gates-${String(Date.now())}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('needsSetup', () => {
    it('returns true when node_modules does not exist', () => {
      expect(needsSetup(testDir)).toBe(true)
    })

    it('returns false when node_modules directory exists', async () => {
      await mkdir(join(testDir, 'node_modules'))
      expect(needsSetup(testDir)).toBe(false)
    })

    it('returns false when node_modules is a file (edge case)', async () => {
      // Weird edge case but we don't want to break if someone has a file named node_modules
      await writeFile(join(testDir, 'node_modules'), 'weird')
      expect(needsSetup(testDir)).toBe(false)
    })

    it('returns true for nonexistent directory', () => {
      expect(needsSetup('/no/such/path')).toBe(true)
    })
  })

  describe('setupLogMessage', () => {
    it('summarizes a successful setup', () => {
      const msg = setupLogMessage(0, 'npm install done')
      expect(msg).toMatch(/succeeded/i)
      expect(msg).toMatch(/setup/)
    })

    it('summarizes a failed setup with exit code and output', () => {
      const msg = setupLogMessage(1, 'npm ERR! Cannot find module tsx')
      expect(msg).toMatch(/failed/i)
      expect(msg).toMatch(/exit.*1/)
      expect(msg).toContain('tsx')
    })

    it('handles null exit code (process killed)', () => {
      const msg = setupLogMessage(null, 'killed')
      expect(msg).toMatch(/failed/i)
      expect(msg).toContain('killed')
    })
  })
})
