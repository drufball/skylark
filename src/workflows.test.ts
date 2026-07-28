import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * `anthropics/claude-code-action`'s `--model` flag accepts floating aliases
 * (`opus`, `sonnet`, `haiku`, …) that the action resolves to a concrete model
 * ID on its own — and that resolution has been wrong before: `opus` resolved
 * to the nonexistent `claude-opus-5`, killing every change-review run in
 * ~45s with `is_error:true`, leaving the advisory `review` check permanently
 * red on every PR (#souf). A red check nobody can ever fix by pushing good
 * code trains everyone to ignore red.
 *
 * Every workflow's `claude_args` must pin a real, versioned model ID instead
 * of trusting the alias to keep resolving to something real.
 */
describe('GitHub workflows never pass a floating model alias to claude-code-action', () => {
  const WORKFLOWS_DIR = join(import.meta.dirname, '..', '.github', 'workflows')

  // Aliases the action is known to accept and silently resolve itself —
  // exactly the class of value that broke here.
  const FLOATING_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'default'])

  function workflowFiles(): string[] {
    return readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'))
  }

  it('pins a real model id in claude_args, not a bare alias', () => {
    const offenders: string[] = []
    for (const file of workflowFiles()) {
      const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8')
      for (const match of source.matchAll(/--model\s+(\S+)/g)) {
        const model = match[1]
        if (FLOATING_ALIASES.has(model)) {
          offenders.push(`${file}: --model ${model}`)
        }
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `floating model alias in claude_args: ${offenders.join(', ')} — pin a real, versioned model id instead (see #souf)`
        : '',
    ).toEqual([])
  })
})
