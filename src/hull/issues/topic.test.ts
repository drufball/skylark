import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ISSUE_TOPIC_PATTERN, ISSUE_TOPIC_PREFIX, issueTopic } from './topic'

describe('issue topic namespace', () => {
  it('namespaces an issue id into its own ship-log topic', () => {
    expect(issueTopic('abcd')).toBe('issue:abcd')
  })

  it('builds the topic and the board pattern from one prefix', () => {
    expect(issueTopic('abcd')).toBe(`${ISSUE_TOPIC_PREFIX}abcd`)
    expect(ISSUE_TOPIC_PATTERN).toBe(`${ISSUE_TOPIC_PREFIX}*`)
  })
})

/**
 * Make-or-break boundary probe. This leaf is imported by BROWSER routes (the
 * issue thread + board), so everything it imports is bundled for the client.
 * service.ts imports node:crypto and pulls in pi-agent-core (which touches
 * `Buffer`) — all server-only; reaching the topic through it once put node code
 * in the client bundle and the page died with "Buffer is not defined". Guard the
 * leaf itself: if topic.ts ever grows a server-only import, that whole class of
 * regression is back for every route that imports it. Asserting on the leaf
 * holds no matter how many routes consume it.
 */
describe('topic.ts stays a node-free leaf', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./topic.ts', import.meta.url)),
    'utf8',
  )

  it('imports nothing server-only', () => {
    // Match the `from '…'` clause only — the prose above names these on purpose.
    expect(src).not.toMatch(/from\s+['"]node:/)
    expect(src).not.toMatch(/from\s+['"][^'"]*pi-agent-core/)
    expect(src).not.toMatch(/from\s+['"]\.\/(service|server|schema)['"]/)
  })
})
