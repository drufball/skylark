import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ISSUE_SCOPE_PATTERN, ISSUE_SCOPE_PREFIX, issueScope } from './scope'

describe('issue scope namespace', () => {
  it('namespaces an issue id into its own ship-log scope', () => {
    expect(issueScope('abcd')).toBe('issue:abcd')
  })

  it('builds the scope and the board pattern from one prefix', () => {
    expect(issueScope('abcd')).toBe(`${ISSUE_SCOPE_PREFIX}abcd`)
    expect(ISSUE_SCOPE_PATTERN).toBe(`${ISSUE_SCOPE_PREFIX}*`)
  })
})

/**
 * Make-or-break boundary probe. This leaf is imported by BROWSER routes (the
 * issue thread + board), so everything it imports is bundled for the client.
 * service.ts imports node:crypto and pulls in pi-agent-core (which touches
 * `Buffer`) — all server-only; reaching the scope through it once put node code
 * in the client bundle and the page died with "Buffer is not defined". Guard the
 * leaf itself: if scope.ts ever grows a server-only import, that whole class of
 * regression is back for every route that imports it. Asserting on the leaf
 * holds no matter how many routes consume it.
 */
describe('scope.ts stays a node-free leaf', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./scope.ts', import.meta.url)),
    'utf8',
  )

  it('imports nothing server-only', () => {
    // Match the `from '…'` clause only — the prose above names these on purpose.
    expect(src).not.toMatch(/from\s+['"]node:/)
    expect(src).not.toMatch(/from\s+['"][^'"]*pi-agent-core/)
    expect(src).not.toMatch(/from\s+['"]\.\/(service|server|schema)['"]/)
  })
})
