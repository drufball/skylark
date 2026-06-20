import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('home/README.md', () => {
  it('starts with an ASCII banner comment', () => {
    const readmePath = join(__dirname, 'README.md')
    const content = readFileSync(readmePath, 'utf-8')
    const lines = content.split('\n')

    // The first line should be an HTML comment with an ASCII banner
    expect(lines[0]).toMatch(/^<!--\s*=+\s*HOME\s*=+\s*-->$/)
  })
})
