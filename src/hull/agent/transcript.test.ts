import { describe, expect, it } from 'vitest'

import { sessionStats, toChatItems } from './transcript'

describe('toChatItems', () => {
  it('renders a user message from string or block content', () => {
    expect(
      toChatItems([
        { role: 'user', content: 'hello' },
        { role: 'user', content: [{ type: 'text', text: 'hi again' }] },
      ]),
    ).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'user', text: 'hi again' },
    ])
  })

  it('splits an assistant message into thinking, text, and tool-call items', () => {
    const items = toChatItems([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me look' },
          {
            type: 'toolCall',
            id: 't1',
            name: 'read',
            arguments: { path: 'x' },
          },
          { type: 'text', text: 'done' },
        ],
      },
    ])

    expect(items).toEqual([
      { kind: 'thinking', text: 'let me look' },
      { kind: 'toolCall', id: 't1', name: 'read', args: '{"path":"x"}' },
      { kind: 'assistant', text: 'done' },
    ])
  })

  it('renders a tool result with its name and error flag', () => {
    expect(
      toChatItems([
        {
          role: 'toolResult',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: 'command failed' }],
        },
      ]),
    ).toEqual([
      {
        kind: 'toolResult',
        name: 'bash',
        isError: true,
        text: 'command failed',
      },
    ])
  })

  it('skips empty and malformed entries without throwing', () => {
    expect(
      toChatItems([
        null,
        'nonsense',
        { role: 'user', content: '' },
        { role: 'assistant', content: [{ type: 'image' }, {}] },
        { role: 'unknown', content: 'x' },
      ]),
    ).toEqual([])
  })

  it('renders unserializable tool args without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(
      toChatItems([
        {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'x', arguments: circular }],
        },
      ]),
    ).toEqual([
      { kind: 'toolCall', id: '', name: 'x', args: '[unserializable]' },
    ])
  })

  it('defaults a tool call with missing fields rather than dropping it', () => {
    expect(
      toChatItems([{ role: 'assistant', content: [{ type: 'toolCall' }] }]),
    ).toEqual([{ kind: 'toolCall', id: '', name: 'tool', args: '' }])
  })

  it('never dereferences a non-object entry', () => {
    // Top-level guard: primitives and null arrive from Postgres as opaque JSON
    // and must be skipped, never read for a `.role`.
    expect(() => toChatItems([null, 'str', 42, true])).not.toThrow()
    expect(toChatItems([null, 'str', 42, true])).toEqual([])
  })

  it('renders string tool args verbatim and null args as empty', () => {
    // A string is passed through untouched (not re-JSON-encoded with quotes),
    // and null/undefined collapse to an empty string rather than the literal
    // "null"/"undefined" that JSON.stringify would produce.
    expect(
      toChatItems([
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'a', arguments: 'raw string' },
            { type: 'toolCall', name: 'b', arguments: null },
          ],
        },
      ]),
    ).toEqual([
      { kind: 'toolCall', id: '', name: 'a', args: 'raw string' },
      { kind: 'toolCall', id: '', name: 'b', args: '' },
    ])
  })

  it('reads text only from well-formed text blocks, never leaking other fields', () => {
    // Untrusted content from Postgres: a non-object block, a wrong-typed block
    // that happens to carry a `text` field, and a text block whose `text` isn't
    // a string must all be ignored — only the real text block contributes.
    expect(
      toChatItems([
        {
          role: 'user',
          content: [
            null,
            { type: 'image', text: 'should-be-ignored' },
            { type: 'text', text: 42 },
            { type: 'text', text: 'real' },
          ],
        },
      ]),
    ).toEqual([{ kind: 'user', text: 'real' }])
  })

  it('skips a message whose content is neither a string nor an array', () => {
    // contentText must defend against a non-array, non-string content value
    // (it would otherwise call .map on it and throw).
    expect(toChatItems([{ role: 'user', content: 42 }])).toEqual([])
  })

  it('does not treat array content on a non-assistant role as assistant blocks', () => {
    // Only role === 'assistant' may walk the block array; a stray role with an
    // array payload must not be mined for assistant text.
    expect(
      toChatItems([
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      ]),
    ).toEqual([])
  })

  it('skips an assistant message whose content is not iterable, without throwing', () => {
    expect(toChatItems([{ role: 'assistant', content: 7 }])).toEqual([])
  })

  it('narrows assistant blocks: ignores malformed, wrong-typed, and empty ones', () => {
    expect(
      toChatItems([
        {
          role: 'assistant',
          content: [
            null, // not an object — skipped, not crashed on
            { type: 'note', text: 'leak-text' }, // wrong type carrying text
            { type: 'text', text: 99 }, // text block, text not a string
            { type: 'text', text: '' }, // empty text is dropped
            { type: 'note', thinking: 'leak-think' }, // wrong type carrying thinking
            { type: 'thinking', thinking: 7 }, // thinking block, thinking not a string
            { type: 'text', text: 'kept' }, // the one real item
          ],
        },
      ]),
    ).toEqual([{ kind: 'assistant', text: 'kept' }])
  })

  it('falls back to a default tool name and a false error flag on a tool result', () => {
    // toolName missing → 'tool'; isError anything-but-true → false.
    expect(
      toChatItems([
        {
          role: 'toolResult',
          isError: 'nope',
          content: [{ type: 'text', text: 'output' }],
        },
      ]),
    ).toEqual([
      { kind: 'toolResult', name: 'tool', isError: false, text: 'output' },
    ])
  })
})

describe('sessionStats', () => {
  it('counts total messages and a per-role breakdown', () => {
    const stats = sessionStats([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'toolResult', content: [] },
      { role: 'toolResult', content: [] },
    ])

    expect(stats.total).toBe(4)
    expect(stats.byRole).toEqual({ user: 1, assistant: 1, toolResult: 2 })
  })

  it('counts tool calls by walking assistant content blocks, not stored rows', () => {
    const stats = sessionStats([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking' },
          { type: 'toolCall', id: 't1', name: 'read', arguments: {} },
          { type: 'toolCall', id: 't2', name: 'bash', arguments: {} },
        ],
      },
      { role: 'toolResult', content: [] },
    ])

    expect(stats.toolCalls).toBe(2)
  })

  it('is defensive of malformed rows, the same way toChatItems is', () => {
    // Non-object rows still count toward the total (they're real stored
    // rows) but contribute nothing to the role breakdown — there's no role to
    // read off them. A role-bearing row with a non-array content is counted
    // by role but walked for no tool calls.
    expect(
      sessionStats([null, 42, { role: 'assistant', content: 'not an array' }]),
    ).toEqual({ total: 3, byRole: { assistant: 1 }, toolCalls: 0 })
  })

  it('returns zeroed stats for an empty session', () => {
    expect(sessionStats([])).toEqual({ total: 0, byRole: {}, toolCalls: 0 })
  })
})
