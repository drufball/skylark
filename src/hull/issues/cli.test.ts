import { describe, expect, it } from 'vitest'
import { parseNewArgs } from './cli'

describe('parseNewArgs', () => {
  it('parses a bare title', () => {
    expect(parseNewArgs(['Fix', 'the', 'bug'])).toEqual({
      title: 'Fix the bug',
      body: undefined,
    })
  })

  it('extracts --body wherever it sits, keeping the rest as the title', () => {
    expect(
      parseNewArgs(['Add', 'feature', '--body', 'The body', 'to', 'project']),
    ).toEqual({
      title: 'Add feature to project',
      body: 'The body',
    })
    expect(parseNewArgs(['--body', 'Body text', 'Issue', 'title'])).toEqual({
      title: 'Issue title',
      body: 'Body text',
    })
    expect(parseNewArgs(['Issue', 'title', '--body', 'Body text'])).toEqual({
      title: 'Issue title',
      body: 'Body text',
    })
  })

  it('yields an empty title (a usage error upstream) when only flags are given', () => {
    expect(parseNewArgs(['--body', 'Body text'])).toEqual({
      title: '',
      body: 'Body text',
    })
    expect(parseNewArgs([])).toEqual({
      title: '',
      body: undefined,
    })
  })
})

describe('parseNewArgs — strict flag values', () => {
  it('rejects a flag with no value, or with another flag where its value goes', () => {
    expect(() => parseNewArgs(['Fix', '--body'])).toThrow(/--body requires/)
    expect(() => parseNewArgs(['Fix', '--body', '--owner', 'x'])).toThrow(
      /--body requires/,
    )
    expect(() => parseNewArgs(['Fix', '--owner'])).toThrow(/--owner requires/)
  })
})

describe('parseNewArgs — owner', () => {
  it('extracts --owner (a crew handle), with or without the @', () => {
    expect(parseNewArgs(['Fix', 'it', '--owner', 'tilde'])).toEqual({
      title: 'Fix it',
      body: undefined,
      ownerHandle: 'tilde',
    })
    expect(parseNewArgs(['Fix', 'it', '--owner', '@tilde']).ownerHandle).toBe(
      'tilde',
    )
  })

  it('leaves ownerHandle undefined when the flag is absent — owner defaults to the creator downstream', () => {
    expect(parseNewArgs(['Fix', 'it']).ownerHandle).toBeUndefined()
  })
})

describe('parseNewArgs — playbook', () => {
  it('extracts --playbook alongside the other flags', () => {
    expect(
      parseNewArgs([
        'Do',
        'research',
        '--playbook',
        'general',
        '--owner',
        'tilde',
      ]),
    ).toEqual({
      title: 'Do research',
      body: undefined,
      ownerHandle: 'tilde',
      playbookName: 'general',
    })
  })

  it('leaves playbookName undefined when absent — the build default downstream', () => {
    expect(parseNewArgs(['Fix', 'it']).playbookName).toBeUndefined()
    expect(() => parseNewArgs(['Fix', '--playbook'])).toThrow(
      /--playbook requires/,
    )
  })
})

describe('parseNewArgs — unknown flags (#7u5b)', () => {
  it('rejects a leftover --flag-looking token instead of folding it into the title', () => {
    // This is what survives when the SEPARATOR (`npm run issue -- new ...`) is
    // present but the flag itself is just unrecognized.
    expect(() => parseNewArgs(['Fix', 'it', '--wombat', 'thing'])).toThrow(
      /Unknown flag: --wombat/,
    )
  })

  it('mentions the `--` separator in the unknown-flag error, the actual root cause', () => {
    expect(() => parseNewArgs(['Fix', 'it', '--wombat'])).toThrow(/--/)
  })
})

describe('parseNewArgs — title length backstop (#7u5b)', () => {
  it('accepts a title right at the limit', () => {
    const title = 'x'.repeat(200)
    expect(parseNewArgs([title]).title).toBe(title)
  })

  it(
    'rejects a title over the limit — this is what npm silently eating --body\n' +
      '     looks like: the whole body text ends up joined into the title',
    () => {
      // Simulates `npm run issue new "Title" --body "<huge text>"` run WITHOUT
      // the `--` separator: npm strips the `--body` flag itself before the CLI
      // ever sees it, leaving only its value as bare words.
      const hugeBodyWords = 'word '.repeat(50).trim().split(' ')
      expect(() => parseNewArgs(['Title', ...hugeBodyWords])).toThrow(
        /over the 200-character limit/,
      )
    },
  )
})
