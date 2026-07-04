import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The structural rules of src/zine.md, enforced. ESLint holds the deck
 * direction (home → rigging → hull) per-import; these tests hold what a lint
 * rule can't see in one file: the shape of the whole graph.
 *
 * - Services are decoupled: a service touches only its own tables. Importing
 *   another service's schema is the compile-time tell that it doesn't — so
 *   every cross-service schema import must be on the named allowlist below.
 * - The import graph is acyclic. One cycle invites the next; zero is cheap to
 *   keep only while it's zero.
 *
 * When a new exception is genuinely earned (a referential-integrity FK), add
 * it here CONSCIOUSLY — the diff on this file is the design review.
 */

/**
 * Cross-service schema imports that are allowed, and from where:
 *
 * - `users` — the crew primitive. Every row knows its crew, so FK-ing and
 *   joining users for identity is the system working as designed. Allowed
 *   from any hull file.
 * - Declared FKs between service schemas (referential integrity is worth the
 *   coupling on a small ship). Allowed ONLY from the owning service's own
 *   schema.ts: issues → agent, issues → chat, chat → agent.
 */
const SCHEMA_FK_ALLOWLIST = new Set([
  'issues -> agent',
  'issues -> chat',
  'chat -> agent',
])

const SRC = join(import.meta.dirname)

/** Every source file under src/, repo-style posix paths relative to src/. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => {
      const dir = relative(SRC, e.parentPath).split(sep).join('/')
      return dir ? `${dir}/${e.name}` : e.name
    })
    .filter((p) => p !== 'routeTree.gen.ts')
}

/** Static import/export specifiers in a file (string literals only). */
function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1])
  }
  return specs
}

/** Resolve a specifier to a src-relative module path, or null if external. */
function resolveToSrcPath(spec: string, fromFile: string): string | null {
  if (spec.startsWith('@hull/')) return `hull/${spec.slice('@hull/'.length)}`
  if (spec.startsWith('@rigging/'))
    return `rigging/${spec.slice('@rigging/'.length)}`
  if (spec.startsWith('@home/')) return `home/${spec.slice('@home/'.length)}`
  if (spec.startsWith('@/')) return spec.slice('@/'.length)
  if (spec.startsWith('.')) {
    return posix.normalize(posix.join(posix.dirname(fromFile), spec))
  }
  return null
}

/** The module path as an actual file in the file set, or null. */
function toFile(modulePath: string, files: Set<string>): string | null {
  for (const candidate of [
    modulePath,
    `${modulePath}.ts`,
    `${modulePath}.tsx`,
    `${modulePath}/index.ts`,
  ]) {
    if (files.has(candidate)) return candidate
  }
  return null
}

function buildGraph(): Map<string, string[]> {
  const files = sourceFiles()
  const fileSet = new Set(files)
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const source = readFileSync(join(SRC, file), 'utf8')
    const edges: string[] = []
    for (const spec of importSpecifiers(source)) {
      const modulePath = resolveToSrcPath(spec, file)
      if (!modulePath) continue
      const target = toFile(modulePath, fileSet)
      if (target) edges.push(target)
    }
    graph.set(file, edges)
  }
  return graph
}

describe('architecture: service decoupling', () => {
  it('cross-service schema imports stay on the named allowlist', () => {
    const violations: string[] = []
    for (const file of sourceFiles()) {
      if (file.includes('.test.')) continue
      const svcMatch = /^hull\/([a-z-]+)\//.exec(file)
      if (!svcMatch) continue
      const service = svcMatch[1]
      const source = readFileSync(join(SRC, file), 'utf8')
      for (const spec of importSpecifiers(source)) {
        const m = /^@hull\/([a-z-]+)\/schema$/.exec(spec)
        if (!m || m[1] === service) continue
        const target = m[1]
        // Identity joins on the crew primitive are the design, not a leak.
        if (target === 'users') continue
        const isOwnSchemaFile = file === `hull/${service}/schema.ts`
        const allowed =
          isOwnSchemaFile && SCHEMA_FK_ALLOWLIST.has(`${service} -> ${target}`)
        if (!allowed) {
          violations.push(
            `${file} imports @hull/${target}/schema — a service reads only its own tables; ` +
              `ask the ${target} service a question (export a function) or emit/subscribe on the ship's log. ` +
              `A genuine new FK belongs in ${service}/schema.ts plus the allowlist in architecture.test.ts.`,
          )
        }
      }
    }
    expect(violations).toEqual([])
  })
})

/** The first import cycle in the graph, as a file path loop, or null. */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  function visit(node: string): string[] | null {
    const s = state.get(node)
    if (s === 'done') return null
    if (s === 'visiting') return [...stack.slice(stack.indexOf(node)), node]
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    state.set(node, 'done')
    return null
  }

  for (const node of graph.keys()) {
    const found = visit(node)
    if (found) return found
  }
  return null
}

describe('architecture: the import graph is acyclic', () => {
  it('src/ has no import cycles', () => {
    const cycle = findCycle(buildGraph())
    expect(cycle, cycle ? `import cycle: ${cycle.join(' → ')}` : '').toBeNull()
  })
})

describe('architecture: boot is server-entry-only', () => {
  /**
   * src/boot.ts arms every reactor and transitively imports the whole hull —
   * node builtins included. The ONLY file that may import it is src/server.ts
   * (the TanStack Start server entry, which never reaches the client bundle).
   * Importing boot from anywhere else — a route, a router, or a serverFn
   * module like hull/chat/server.ts — drags server code into the client graph
   * ("ReferenceError: Buffer is not defined", observed live after PR #92).
   */
  it('only src/server.ts imports src/boot.ts', () => {
    const violations: string[] = []
    for (const [file, edges] of buildGraph()) {
      if (file === 'server.ts' || file === 'boot.test.ts') continue
      if (edges.includes('boot.ts')) {
        violations.push(
          `${file} imports @/boot — boot belongs to the server entry (src/server.ts) only; ` +
            `client-reachable modules must never pull it into their graph.`,
        )
      }
    }
    expect(violations).toEqual([])
  })
})
