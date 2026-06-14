import { describe, expect, it } from 'vitest'

import { toChatItems } from './transcript'

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
})
