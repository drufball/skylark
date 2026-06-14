/**
 * Flatten stored pi.dev messages into a flat list of view items the chat UI can
 * render without knowing anything about the SDK's message shapes. Pure and
 * defensive: messages arrive from Postgres as opaque JSON, so this narrows by
 * the discriminants it knows and skips what it doesn't.
 */

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  // `args` is the tool-call arguments rendered to a string here (rather than
  // left as an opaque object) so the whole item crosses the server/client wire
  // as plain serializable data.
  | { kind: 'toolCall'; id: string; name: string; args: string }
  | { kind: 'toolResult'; name: string; isError: boolean; text: string }

interface RawMessage {
  role?: unknown
  content?: unknown
  toolName?: unknown
  isError?: unknown
}

interface RawBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
  name?: unknown
  id?: unknown
  arguments?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Render tool-call arguments to a compact string for display. */
function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return '[unserializable]'
  }
}

/** Join the text of a content value that's either a string or a block array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: RawBlock) =>
      isObject(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('')
}

export function toChatItems(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = []

  for (const raw of messages) {
    if (!isObject(raw)) continue
    const message = raw as RawMessage

    if (message.role === 'user') {
      const text = contentText(message.content)
      if (text) items.push({ kind: 'user', text })
      continue
    }

    if (message.role === 'toolResult') {
      items.push({
        kind: 'toolResult',
        name: typeof message.toolName === 'string' ? message.toolName : 'tool',
        isError: message.isError === true,
        text: contentText(message.content),
      })
      continue
    }

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content as RawBlock[]) {
        if (!isObject(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text) items.push({ kind: 'assistant', text: block.text })
        } else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string'
        ) {
          items.push({ kind: 'thinking', text: block.thinking })
        } else if (block.type === 'toolCall') {
          items.push({
            kind: 'toolCall',
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : 'tool',
            args: stringifyArgs(block.arguments),
          })
        }
      }
    }
  }

  return items
}
