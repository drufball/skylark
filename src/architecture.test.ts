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
 *   schema.ts: issues → agent, chat → agent. Issues knows nothing about chat —
 *   an agent finds the right conversation itself (see the chat waker). The
 *   night watch keys its OWN memory tables by the issue and the background job
 *   it tracks, cascade-deleting so its memory can't outlive them: watch →
 *   issues, watch → agent. The home canvas holds POINTERS at things that live
 *   in chats, so its tile rows FK the chat and the widget they point at and
 *   cascade with them — that FK is what makes "a pointer can never dangle" a
 *   database fact rather than a sweep: home-canvas → chat. It reads chat's DATA
 *   only by calling chat's own exported functions, under the viewer's RLS
 *   context, which is what keeps "may this person see it?" living in chat.
 */
const SCHEMA_FK_ALLOWLIST = new Set([
  'issues -> agent',
  'chat -> agent',
  'watch -> issues',
  'watch -> agent',
  'home-canvas -> chat',
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

/**
 * Static VALUE import/export specifiers in a file (string literals only).
 * Excludes `import type` and `import()` dynamic imports.
 *
 * Dynamic imports are excluded because they don't pull code into the initial
 * bundle - they're loaded on demand. If a dynamic import is inside a
 * createServerFn handler, it stays server-side (the handler never executes
 * on the client).
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const patterns = [
    // import/export from, but NOT "import type" or "export type". `[^'"]`
    // (not `[^'"\n]`) so prettier-wrapped multi-line imports count too — with
    // the newline exclusion the graph silently dropped every wrapped import,
    // which is most of them.
    /(?:^|\n)\s*(?:import|export)(?!\s+type\s)[^'"]*?from\s*['"]([^'"]+)['"]/g,
    // Side-effect import
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    // NOTE: Deliberately omitting dynamic import() - see comment above
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

/**
 * Schema-import violations in one file. Two rules share the walk:
 *
 * - Inside the hull, a service touches only its own tables; cross-service
 *   schema imports must be on the FK allowlist. Matched on the RESOLVED module
 *   path, not the specifier — `../issues/schema` is the same import as
 *   `@hull/issues/schema` and must not slide past on spelling.
 * - Above the hull (rigging, home), a VALUE import of any hull schema is a
 *   deck reading another service's tables directly. Decks ask a service
 *   questions through its exported functions; `import type` is fine (erased at
 *   runtime) and is already invisible to `importSpecifiers`. The serving layer
 *   (src root, routes/) is exempt — wiring the decks together is its job.
 */
function schemaImportViolations(file: string, source: string): string[] {
  const violations: string[] = []
  const service = /^hull\/([a-z-]+)\//.exec(file)?.[1] ?? null
  const aboveDeck = /^(?:rigging|home)\//.test(file)
  if (!service && !aboveDeck) return violations
  for (const spec of importSpecifiers(source)) {
    const resolved = resolveToSrcPath(spec, file)
    if (!resolved) continue
    const m = /^hull\/([a-z-]+)\/schema$/.exec(resolved)
    if (!m) continue
    const target = m[1]
    if (service) {
      if (target === service) continue
      // Identity joins on the crew primitive are the design, not a leak.
      if (target === 'users') continue
      const isOwnSchemaFile = file === `hull/${service}/schema.ts`
      if (isOwnSchemaFile && SCHEMA_FK_ALLOWLIST.has(`${service} -> ${target}`))
        continue
      violations.push(
        `${file} imports @hull/${target}/schema — a service reads only its own tables; ` +
          `ask the ${target} service a question (export a function) or emit/subscribe on the ship's log. ` +
          `A genuine new FK belongs in ${service}/schema.ts plus the allowlist in architecture.test.ts.`,
      )
    } else {
      violations.push(
        `${file} value-imports @hull/${target}/schema — a deck above the hull reads a service ` +
          `through its exported functions, never its tables. \`import type\` is fine.`,
      )
    }
  }
  return violations
}

describe('architecture: service decoupling', () => {
  it('cross-service schema imports stay on the named allowlist', () => {
    const violations: string[] = []
    for (const file of sourceFiles()) {
      if (file.includes('.test.')) continue
      violations.push(
        ...schemaImportViolations(file, readFileSync(join(SRC, file), 'utf8')),
      )
    }
    expect(violations).toEqual([])
  })

  // The rule's own edge cases, pinned so the check can't quietly regress to
  // matching specifier SPELLING or to binding only inside the hull — the two
  // evasions the 2026-07-28 review found open.
  it('catches a cross-service schema import spelled relatively', () => {
    expect(
      schemaImportViolations(
        'hull/chat/sneaky.ts',
        `import { issues } from '../issues/schema'\n`,
      ),
    ).toHaveLength(1)
  })

  it('catches a rigging value-import of a hull schema (users included)', () => {
    expect(
      schemaImportViolations(
        'rigging/widgets/sneaky.tsx',
        `import { issues } from '@hull/issues/schema'\n`,
      ),
    ).toHaveLength(1)
    expect(
      schemaImportViolations(
        'rigging/rooms/sneaky.ts',
        `import { users } from '@hull/users/schema'\n`,
      ),
    ).toHaveLength(1)
  })

  it('leaves type-only imports, own schemas, and allowlisted FKs alone', () => {
    expect(
      schemaImportViolations(
        'rigging/widgets/fine.tsx',
        `import type { IssueStatus } from '@hull/issues/schema'\n`,
      ),
    ).toEqual([])
    expect(
      schemaImportViolations(
        'hull/chat/service.ts',
        `import { chats } from './schema'\n`,
      ),
    ).toEqual([])
    expect(
      schemaImportViolations(
        'hull/watch/schema.ts',
        `import { issues } from '@hull/issues/schema'\n`,
      ),
    ).toEqual([])
    // ...but the same FK import from a NON-schema file of the service is not
    // covered by the allowlist.
    expect(
      schemaImportViolations(
        'hull/watch/service.ts',
        `import { issues } from '@hull/issues/schema'\n`,
      ),
    ).toHaveLength(1)
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

/**
 * Walk the import graph from a starting file, collecting all transitively
 * reached files. Returns the set of all files in the transitive closure.
 * Nodes in `boundaries` are visited but not expanded — their own imports are
 * outside the closure.
 */
function transitiveImports(
  start: string,
  graph: Map<string, string[]>,
  boundaries = new Set<string>(),
): Set<string> {
  const visited = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || visited.has(node)) continue
    visited.add(node)
    if (node !== start && boundaries.has(node)) continue
    for (const next of graph.get(node) ?? []) {
      if (!visited.has(next)) stack.push(next)
    }
  }
  return visited
}

/**
 * createServerFn door modules. The TanStack Start compiler splits these for
 * the client bundle — each server fn becomes an RPC stub and the handler's
 * imports are dead-code-eliminated — so a door's server-side imports (the db
 * client, node builtins) never reach the browser. The node-builtin closure
 * tests treat doors as boundaries: importing a door from client code is the
 * sanctioned path, so the walk stops there. (A door must still export ONLY
 * server fns and types to client code — a plain value export would survive
 * the split and drag its imports along; this approximation doesn't catch
 * that.)
 */
function doorModules(files: string[]): Set<string> {
  return new Set(
    files.filter((file) =>
      readFileSync(join(SRC, file), 'utf8').includes('createServerFn('),
    ),
  )
}

/**
 * Check if a file directly imports a Node builtin (node:* specifier).
 */
function importsNodeBuiltin(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8')
  const builtins: string[] = []
  for (const spec of importSpecifiers(source)) {
    if (spec.startsWith('node:')) {
      builtins.push(spec)
    }
  }
  return builtins
}

describe('architecture: client code must not import node builtins', () => {
  /**
   * Routes and rigging/views are isomorphic — they run on both server and
   * client, so they're bundled into the client bundle. If they transitively
   * import a Node builtin (node:fs, node:child_process, etc.), the build
   * externalizes it and the browser throws "Module externalized for browser
   * compatibility" or "X is not defined" (Buffer, process, etc.), crashing
   * hydration.
   *
   * Server-only code must reach client code ONLY through createServerFn doors
   * (which become RPC stubs client-side) or via `import type` (erased at
   * runtime). This test enforces "loader → server fn → pure service" by
   * construction.
   *
   * Context: PR #54 (node:os via a value import), PR #92 (node:child_process
   * via @/boot), both caught by hand or smoke tests — silent at build time.
   */
  it('routes must not transitively import node:* builtins', () => {
    const graph = buildGraph()
    const files = sourceFiles()
    const doors = doorModules(files)
    const violations: string[] = []

    for (const file of files) {
      if (!file.startsWith('routes/')) continue
      if (file.includes('.test.')) continue

      const closure = transitiveImports(file, graph, doors)
      for (const reached of closure) {
        if (doors.has(reached)) continue
        const builtins = importsNodeBuiltin(reached)
        if (builtins.length > 0) {
          violations.push(
            `${file} transitively imports node builtins via ${reached}: ${builtins.join(', ')} — ` +
              `routes are isomorphic (client + server); server-only code must stay behind createServerFn doors or import type.`,
          )
          break // one violation per route is enough
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('rigging/views must not transitively import node:* builtins', () => {
    const graph = buildGraph()
    const files = sourceFiles()
    const doors = doorModules(files)
    const violations: string[] = []

    for (const file of files) {
      if (!file.startsWith('rigging/views/')) continue
      if (file.includes('.test.')) continue

      const closure = transitiveImports(file, graph, doors)
      for (const reached of closure) {
        if (doors.has(reached)) continue
        const builtins = importsNodeBuiltin(reached)
        if (builtins.length > 0) {
          violations.push(
            `${file} transitively imports node builtins via ${reached}: ${builtins.join(', ')} — ` +
              `rigging/views are client components; server-only code must stay behind createServerFn doors or import type.`,
          )
          break // one violation per view is enough
        }
      }
    }

    expect(violations).toEqual([])
  })
})
