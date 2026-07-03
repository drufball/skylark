import { useEffect, useRef, useState } from 'react'
import { Anchor, Loader2, Send, Square } from 'lucide-react'

import type { ChatItem } from '@hull/agent/transcript'
import { truncate } from '@hull/lib/text'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'

// The agent-session monitor, presentational and routing-agnostic: it takes its
// data and a set of callbacks, and knows nothing about fetching, polling, or
// URLs. A thin route wires it to the agent service and the browser's address
// bar. It never starts sessions — those are created by chat/issues — it only
// watches them and unsticks a wedged one with a direct message.

export interface SessionSummary {
  id: string
  title: string | null
  status: 'idle' | 'running' | 'error'
}

export interface AgentChatViewProps {
  sessions: SessionSummary[]
  activeId?: string
  items: ChatItem[]
  /** The active session has a turn in flight. */
  running: boolean
  /** A send/start request is in flight — the composer is disabled. */
  busy: boolean
  error?: string | null
  onSend: (text: string) => void
  onCancel: () => void
  onSelect: (id: string) => void
  /** The empty-state copy, shown when no session is selected. */
  emptyTitle: string
  emptyHint: string
}

export function AgentChatView({
  sessions,
  activeId,
  items,
  running,
  busy,
  error,
  onSend,
  onCancel,
  onSelect,
  emptyTitle,
  emptyHint,
}: AgentChatViewProps) {
  return (
    <main className="flex h-full bg-background text-foreground">
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={onSelect}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        <Transcript
          items={items}
          activeId={activeId}
          running={running}
          emptyTitle={emptyTitle}
          emptyHint={emptyHint}
        />
        {error && (
          <p className="border-t border-destructive/30 bg-destructive/10 px-6 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Composer
          busy={busy}
          running={running}
          onSend={onSend}
          onCancel={onCancel}
        />
      </section>
    </main>
  )
}

function SessionList({
  sessions,
  activeId,
  onSelect,
}: Pick<AgentChatViewProps, 'sessions' | 'activeId' | 'onSelect'>) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/30">
      <div className="flex items-center gap-2 p-3">
        <Anchor className="size-5 text-muted-foreground" />
        <span className="font-semibold">Skylark</span>
      </div>
      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-1 p-2">
          {sessions.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              No conversations yet.
            </p>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                onSelect(session.id)
              }}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                'hover:bg-accent hover:text-accent-foreground',
                session.id === activeId && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="truncate">{session.title ?? '(untitled)'}</span>
              {session.status === 'running' && (
                <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
              {session.status === 'error' && (
                <span className="ml-auto shrink-0 text-destructive">!</span>
              )}
            </button>
          ))}
        </nav>
      </ScrollArea>
    </aside>
  )
}

function Transcript({
  items,
  activeId,
  running,
  emptyTitle,
  emptyHint,
}: Pick<
  AgentChatViewProps,
  'items' | 'activeId' | 'running' | 'emptyTitle' | 'emptyHint'
>) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items.length, running])

  if (!activeId && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-sm">
          <Anchor className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-lg font-medium">{emptyTitle}</p>
          <p className="text-sm text-muted-foreground">{emptyHint}</p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-6">
        {items.map((item, i) => (
          <ChatItemView key={i} item={item} />
        ))}
        {running && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            working…
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="self-end rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
          <p className="whitespace-pre-wrap">{item.text}</p>
        </div>
      )
    case 'assistant':
      return <p className="whitespace-pre-wrap leading-relaxed">{item.text}</p>
    case 'thinking':
      return (
        <p className="whitespace-pre-wrap border-l-2 pl-3 text-sm italic text-muted-foreground">
          {item.text}
        </p>
      )
    case 'toolCall':
      return (
        <code className="self-start rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          🔧 {item.name}({truncate(item.args, 80)})
        </code>
      )
    case 'toolResult':
      return (
        <code
          className={cn(
            'self-start whitespace-pre-wrap rounded-md bg-muted px-2 py-1 font-mono text-xs',
            item.isError ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          → {truncate(item.text, 300)}
        </code>
      )
  }
}

function Composer({
  busy,
  running,
  onSend,
  onCancel,
}: Pick<AgentChatViewProps, 'busy' | 'running' | 'onSend' | 'onCancel'>) {
  const [text, setText] = useState('')

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="border-t p-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Message your first mate…  (Enter to send, Shift+Enter for a newline)"
          rows={1}
          className="max-h-40 min-h-[2.5rem] resize-none"
        />
        {running ? (
          <Button
            variant="outline"
            onClick={onCancel}
            aria-label="Stop the agent"
          >
            <Square className="size-4" />
          </Button>
        ) : (
          <Button onClick={submit} disabled={busy} aria-label="Send message">
            <Send className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
