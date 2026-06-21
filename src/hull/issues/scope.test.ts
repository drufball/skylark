import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { issueScope } from './scope'

describe('issueScope', () => {
  it('namespaces an issue id into its own ship-log scope', () => {
    expect(issueScope('abcd')).toBe('issue:abcd')
  })
})

/**
 * Make-or-break boundary probe. The issue thread route runs in the BROWSER, so
 * every runtime module it statically imports is bundled for the client. service.ts
 * imports node:crypto and pulls in pi-agent-core (which touches `Buffer`) — all
 * server-only. If the route imports a runtime value from service.ts, Vite drags
 * that node code into the client bundle and the page dies with "Buffer is not
 * defined". The client needs only the scope string, which is why it lives here in
 * a leaf module with no server-only imports. Keep the route off service.ts.
 */
describe('issue thread route stays off the server-only service module', () => {
  const routeSrc = readFileSync(
    fileURLToPath(new URL('../../routes/issues.$id.tsx', import.meta.url)),
    'utf8',
  )

  it('does not import a runtime value from @hull/issues/service', () => {
    // A `import type { … } from '@hull/issues/service'` is erased at build and
    // harmless; a value import is the one that leaks node into the browser.
    const valueImport =
      /import\s+(?!type\b)[^;]*from\s+['"]@hull\/issues\/service['"]/
    expect(routeSrc).not.toMatch(valueImport)
  })
})
