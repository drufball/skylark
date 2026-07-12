import { useState } from 'react'
import { Bot, Plus, User, Users, X } from 'lucide-react'

import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Composer } from '@rigging/components/composer'
import { CollapsibleSidebar } from '@rigging/components/collapsible-sidebar'
import { inputClass, selectClass } from '@rigging/components/ui/input'

// The front door: chat between the crew — humans and agents. Participant-focused
// (you keep messaging the same people with new tasks), so the sidebar names a
// chat by its members when it has no title, and opens your most recent one.
// Presentational and routing-agnostic: data in, callbacks out. The clean message
// transcript lives here; an agent's tool calls stay in the Agents view.

export interface ChatListItem {
  id: string
  title: string | null
  memberHandles: string[]
}

export interface ChatMsg {
  id: string
  authorHandle: string
  body: string
  mine: boolean
}

export interface ChatMemberItem {
  userId: string
  handle: string
  type: 'human' | 'agent'
}

export interface CrewMember {
  id: string
  handle: string
  displayName: string
  type: 'human' | 'agent'
}

export interface ChatViewProps {
  chats: ChatListItem[]
  activeId?: string
  title: string | null
  members: ChatMemberItem[]
  messages: ChatMsg[]
  /** An agent is mid-reply: show a live placeholder until its message lands. */
  working: { handle: string; line: string } | null
  crew: CrewMember[]
  /** New-chat mode: pick members instead of showing a thread. */
  composing: boolean
  busy: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onSend: (text: string) => void
  onCreate: (memberIds: string[], title: string) => void
  onAddMember: (userId: string) => void
  onRemoveMember: (userId: string) => void
}

/** A chat's display name: its title, or the members it's with. */
export function chatName(item: {
  title: string | null
  memberHandles: string[]
}): string {
  if (item.title) return item.title
  return item.memberHandles.length > 0
    ? item.memberHandles.map((h) => `@${h}`).join(', ')
    : 'New chat'
}

export function ChatView(props: ChatViewProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  return (
    <div className="flex h-full bg-background text-foreground">
      <ChatList
        {...props}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        {props.composing ? (
          <NewChat
            crew={props.crew}
            busy={props.busy}
            onCreate={props.onCreate}
          />
        ) : props.activeId ? (
          <ActiveChat {...props} />
        ) : (
          <Empty />
        )}
      </section>
    </div>
  )
}

function ChatList({
  chats,
  activeId,
  composing,
  onSelect,
  onNew,
  drawerOpen,
  onDrawerOpenChange,
}: ChatViewProps & {
  drawerOpen: boolean
  onDrawerOpenChange: (open: boolean) => void
}) {
  return (
    <CollapsibleSidebar
      label="Chats"
      open={drawerOpen}
      onOpenChange={onDrawerOpenChange}
      className="w-72 bg-muted/30"
    >
      <div className="flex items-center gap-2 p-3">
        <Users className="size-5 text-muted-foreground" />
        <span className="font-semibold">Chats</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={onNew}
          aria-label="New chat"
        >
          <Plus className="size-4" />
          New
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-1 p-2">
          {chats.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              No chats yet.
            </p>
          )}
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => {
                onSelect(chat.id)
                onDrawerOpenChange(false)
              }}
              className={cn(
                'truncate rounded-md px-3 py-2 text-left text-sm',
                'hover:bg-accent hover:text-accent-foreground',
                !composing &&
                  chat.id === activeId &&
                  'bg-accent text-accent-foreground',
              )}
            >
              {chatName(chat)}
            </button>
          ))}
        </nav>
      </ScrollArea>
    </CollapsibleSidebar>
  )
}

function ActiveChat({
  title,
  members,
  messages,
  working,
  crew,
  busy,
  onSend,
  onAddMember,
  onRemoveMember,
}: ChatViewProps) {
  const memberIds = new Set(members.map((m) => m.userId))
  const addable = crew.filter((c) => !memberIds.has(c.id))

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="font-medium">
          {chatName({ title, memberHandles: members.map((m) => m.handle) })}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {members.map((m) => (
            <span
              key={m.userId}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
            >
              {m.type === 'agent' ? (
                <Bot className="size-3" />
              ) : (
                <User className="size-3" />
              )}
              @{m.handle}
              <button
                type="button"
                aria-label={`Remove ${m.handle}`}
                onClick={() => {
                  onRemoveMember(m.userId)
                }}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {addable.length > 0 && (
            <select
              aria-label="Add member"
              className={selectClass('text-xs')}
              value=""
              onChange={(e) => {
                if (e.target.value) onAddMember(e.target.value)
              }}
            >
              <option value="">+ add</option>
              {addable.map((c) => (
                <option key={c.id} value={c.id}>
                  @{c.handle}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>
      <Messages messages={messages} working={working} />
      <Composer
        busy={busy}
        onSend={onSend}
        placeholder="Message…  (@mention an agent in a group; Enter to send)"
      />
    </>
  )
}

function Messages({
  messages,
  working,
}: Pick<ChatViewProps, 'messages' | 'working'>) {
  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-6">
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              'flex flex-col gap-0.5',
              m.mine ? 'items-end' : 'items-start',
            )}
          >
            {!m.mine && (
              <span className="text-xs text-muted-foreground">
                @{m.authorHandle}
              </span>
            )}
            <div
              className={cn(
                'max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2',
                m.mine
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground',
              )}
            >
              {m.body}
            </div>
          </div>
        ))}
        {working && (
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-xs text-muted-foreground">
              @{working.handle}
            </span>
            <div className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-2 text-sm text-muted-foreground">
              <span className="inline-block size-2 animate-pulse rounded-full bg-current" />
              {working.line}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

function NewChat({
  crew,
  busy,
  onCreate,
}: Pick<ChatViewProps, 'crew' | 'busy' | 'onCreate'>) {
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState('')

  function toggle(id: string) {
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    )
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-lg font-medium">New chat</h1>
      <input
        className={inputClass()}
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
        }}
      />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Who's in it?</span>
        <span className="text-xs text-muted-foreground">
          You're always included. Pick the rest of the crew.
        </span>
        <div className="mt-1 flex flex-col gap-1">
          {crew.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => {
                  toggle(c.id)
                }}
              />
              {c.type === 'agent' ? (
                <Bot className="size-3.5" />
              ) : (
                <User className="size-3.5" />
              )}
              @{c.handle}
              <span className="text-xs text-muted-foreground">
                {c.displayName}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <Button
          disabled={busy || selected.length === 0}
          onClick={() => {
            onCreate(selected, title)
          }}
        >
          Start chat
        </Button>
      </div>
    </div>
  )
}

function Empty() {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Users className="mx-auto mb-3 size-8 text-muted-foreground" />
        <p className="text-lg font-medium">Start a conversation</p>
        <p className="text-sm text-muted-foreground">
          Make a chat with your crew — humans and agents. New to begin.
        </p>
      </div>
    </div>
  )
}
