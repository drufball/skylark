import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createBashTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Make-or-break probe for M3: pi.dev's bash/read/write tools must operate
 * relative to the per-session `cwd` passed to the tool factory, NOT the global
 * `process.cwd()`. M3 runs several building agents in-process at once, each in
 * its own git worktree (its own cwd); if the tools secretly used process.cwd()
 * they'd collide and the in-process design is dead.
 *
 * This drives the REAL pi tool layer directly (the same `createBashTool(cwd)` /
 * `createReadTool(cwd)` / `createWriteTool(cwd)` that `createAgentSession` wires
 * up) — no LLM, no API key, fully deterministic. It runs tools bound to two
 * distinct temp dirs while process.cwd() stays the repo, and asserts each tool
 * reads/writes/execs in ITS cwd. If this test ever fails, STOP: the in-process
 * builder design is invalid and we need child processes instead.
 */

function exec(
  tool: { execute: (...a: never[]) => Promise<unknown> },
  params: unknown,
) {
  return (
    tool.execute as unknown as (
      id: string,
      p: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
    ) => Promise<{ content: { type: string; text?: string }[] }>
  )('probe', params, undefined, undefined)
}

function textOf(result: {
  content: { type: string; text?: string }[]
}): string {
  return result.content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')
}

describe('per-session cwd isolation (pi tool layer)', () => {
  let dirA: string
  let dirB: string
  const repoCwd = process.cwd()

  beforeAll(() => {
    dirA = mkdtempSync(join(tmpdir(), 'skylark-cwd-a-'))
    dirB = mkdtempSync(join(tmpdir(), 'skylark-cwd-b-'))
    // Distinct file content in each dir; same RELATIVE name.
    writeFileSync(join(dirA, 'where.txt'), 'I am A')
    writeFileSync(join(dirB, 'where.txt'), 'I am B')
  })

  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  })

  it('process.cwd() is the repo, not either probe dir', () => {
    expect(process.cwd()).toBe(repoCwd)
    expect(process.cwd()).not.toBe(dirA)
    expect(process.cwd()).not.toBe(dirB)
  })

  it('bash runs `pwd` in the tool cwd, not process.cwd()', async () => {
    const a = textOf(await exec(createBashTool(dirA), { command: 'pwd' }))
    const b = textOf(await exec(createBashTool(dirB), { command: 'pwd' }))
    expect(a).toContain(dirA)
    expect(b).toContain(dirB)
    expect(a).not.toContain(dirB)
  })

  it('read resolves a relative path against the tool cwd', async () => {
    const a = textOf(await exec(createReadTool(dirA), { path: 'where.txt' }))
    const b = textOf(await exec(createReadTool(dirB), { path: 'where.txt' }))
    expect(a).toContain('I am A')
    expect(b).toContain('I am B')
  })

  it('write creates a file inside the tool cwd, not process.cwd()', async () => {
    await exec(createWriteTool(dirA), {
      path: 'made-in-a.txt',
      content: 'hello from A',
    })
    // The file exists in dirA…
    expect(readFileSync(join(dirA, 'made-in-a.txt'), 'utf8')).toBe(
      'hello from A',
    )
    // …and was NOT written into the repo cwd.
    expect(() => readFileSync(join(repoCwd, 'made-in-a.txt'), 'utf8')).toThrow()
    expect(() => readFileSync(join(dirB, 'made-in-a.txt'), 'utf8')).toThrow()
  })

  it('two concurrent sessions on different cwds do not collide', async () => {
    const [a, b] = await Promise.all([
      exec(createBashTool(dirA), {
        command: 'echo concurrent > tag.txt && cat tag.txt',
      }),
      exec(createBashTool(dirB), {
        command: 'echo concurrent > tag.txt && cat tag.txt',
      }),
    ])
    expect(textOf(a)).toContain('concurrent')
    expect(textOf(b)).toContain('concurrent')
    // Each wrote into its own dir.
    expect(readFileSync(join(dirA, 'tag.txt'), 'utf8')).toContain('concurrent')
    expect(readFileSync(join(dirB, 'tag.txt'), 'utf8')).toContain('concurrent')
  })
})
