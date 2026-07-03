import { describe, expect, it } from 'vitest'

import { shq } from './shell'

describe('shq', () => {
  it('passes a plain string through, quoted', () => {
    expect(shq('feature-branch')).toBe(`'feature-branch'`)
    expect(shq('/home/crew/skylark/worktrees/fix-1a2b')).toBe(
      `'/home/crew/skylark/worktrees/fix-1a2b'`,
    )
  })

  it('escapes embedded single quotes with the close-escape-reopen form', () => {
    // 'a'\''b' — end the quoted span, emit a literal ', reopen.
    expect(shq(`a'b`)).toBe(`'a'\\''b'`)
  })

  it('quotes the empty string so the argument survives', () => {
    expect(shq('')).toBe(`''`)
  })

  it('keeps a command-substitution payload inert inside single quotes', () => {
    const payload = 'x$(rm -rf ~)y'
    const quoted = shq(payload)
    // Single quotes suppress ALL expansion — the payload must arrive verbatim,
    // wrapped, with no unquoted $ ever exposed.
    expect(quoted).toBe(`'x$(rm -rf ~)y'`)
    expect(quoted.startsWith(`'`)).toBe(true)
    expect(quoted.endsWith(`'`)).toBe(true)
  })

  it('never leaves an embedded quote inside a quoted span', () => {
    // `'$(boom)'` — the attacker quotes first: the embedded quotes are each
    // escaped, so the substitution still sits inside single quotes.
    const quoted = shq(`'$(boom)'`)
    expect(quoted).toBe(`''\\''$(boom)'\\'''`)
  })
})
