import { useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  ChevronRight,
  Plus,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react'

import { parseProps } from '@hull/chat/widgets'
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
  /**
   * The agent's persisted "working…" line, if it's mid-turn right now — the
   * durable half of the placeholder, so it's still here after a page
   * navigation reloads the thread instead of catching a live SSE event.
   */
  progressLine?: string | null
  /**
   * How far this member's turns have read the chat. Only interesting for agents,
   * and only to answer one question honestly: did it read this and choose not to
   * speak? (See `seenByHandles`.)
   */
  lastSeenMessageId?: string | null
}

export interface CrewMember {
  id: string
  handle: string
  displayName: string
  type: 'human' | 'agent'
}

/** A schedule as the view shows it — timing fields arrive as ISO strings (serialized). */
export interface ScheduleItem {
  id: string
  authorHandle: string
  body: string
  enabled: boolean
  intervalMinutes: number | null
  fireAt: string | null
  nextFireAt: string | null
}

/** What the crew is asked to author a schedule with. */
export interface NewSchedule {
  body: string
  /** ISO timestamp for a one-shot; XOR intervalMinutes. */
  fireAt?: string
  /** Whole minutes for a recurring schedule; XOR fireAt. */
  intervalMinutes?: number
}

/**
 * A one-line, human-ready timing summary for a schedule row. Pure and exported
 * so the wording is unit-tested; the view just renders it. A recurring row
 * shows its cadence and next fire; a one-shot shows its single time.
 */
export function scheduleSummary(s: {
  intervalMinutes: number | null
  fireAt: string | null
  nextFireAt: string | null
}): string {
  if (s.intervalMinutes != null) {
    const next = s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : '—'
    return `every ${String(s.intervalMinutes)} min · next ${next}`
  }
  const at = s.fireAt ? new Date(s.fireAt).toLocaleString() : '—'
  return `once · ${at}`
}

/**
 * A widget as the loader hands it over: a `kind` and an opaque `props` blob,
 * exactly as the row holds them. The view is what calls `parseProps` — so a
 * blob an agent got wrong is one honest tile in the stack, not a failed load.
 */
export interface WidgetItem {
  id: string
  kind: string
  props: unknown
  /** Who put it here — a widget is always somebody's judgment, so it's named. */
  createdByHandle: string
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
  /** The active chat's schedules (optional — the CLI is the primary door for v1). */
  schedules?: ScheduleItem[]
  onCreateSchedule?: (input: NewSchedule) => void
  onToggleSchedule?: (id: string, enabled: boolean) => void
  onDeleteSchedule?: (id: string) => void
  /** The active chat's open widgets, already in stack order. */
  widgets?: WidgetItem[]
  onAnswerWidget?: (widgetId: string, value: string) => void
  onDismissWidget?: (widgetId: string) => void
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

/**
 * The working placeholder derived from a chat's own durably-persisted member
 * data (chat/service.ts's `progressLine`), rather than a live SSE event —
 * this is what lets the bubble show up on a fresh load (a page navigation
 * away and back), not only while a tab was open to catch the event live. A
 * route seeds its live `working` state from this on every activeId change;
 * pure and exported so the derivation itself is unit-tested directly.
 */
export function workingFromMembers(
  members: ChatMemberItem[],
): { handle: string; line: string } | null {
  const inProgress = members.find((m) => m.progressLine)
  return inProgress?.progressLine
    ? { handle: inProgress.handle, line: inProgress.progressLine }
    : null
}

/**
 * What the live indicator says. It means ONE thing — this agent is mid-turn —
 * and it must not imply a second: an agent speaks by posting from inside its own
 * turn, so it may have said its piece already and still be working for another
 * half-minute, or it may finish having said nothing at all. So this reads as a
 * state ("@tilde is working"), never as a promise ("@tilde is typing…"), and it
 * is rendered as a status line rather than an empty message bubble waiting to be
 * filled in.
 */
export function workingLabel(working: {
  handle: string
  line: string
}): string {
  return `@${working.handle} is working — ${working.line}`
}

/**
 * Which agents have READ the last thing said without answering it — the quiet
 * counterpart to a reply.
 *
 * Silence is a real outcome now (an agent that calls no `chat_post` says
 * nothing), and unexplained silence reads as a broken ship. Rather than
 * auto-posting a filler message — which is exactly the ventriloquism the
 * orchestrator stopped doing — the thread states the fact it actually has: this
 * agent's turn read the conversation this far. An agent that answered isn't
 * listed, because its own message is already the receipt.
 */
export function seenByHandles(
  members: ChatMemberItem[],
  messages: ChatMsg[],
): string[] {
  const last = messages.at(-1)
  if (!last) return []
  return members
    .filter(
      (m) =>
        m.type === 'agent' &&
        m.handle !== last.authorHandle &&
        m.lastSeenMessageId != null &&
        m.lastSeenMessageId >= last.id,
    )
    .map((m) => m.handle)
}

export function ChatView(props: ChatViewProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      <ChatList
        {...props}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
      />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
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
      className="min-h-0 w-72 bg-muted/30"
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
      <ScrollArea className="min-h-0 flex-1">
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
  schedules,
  onCreateSchedule,
  onToggleSchedule,
  onDeleteSchedule,
  widgets,
  onAnswerWidget,
  onDismissWidget,
}: ChatViewProps) {
  const memberIds = new Set(members.map((m) => m.userId))
  const addable = crew.filter((c) => !memberIds.has(c.id))
  const [showSchedules, setShowSchedules] = useState(false)
  const schedulingOn = Boolean(
    onCreateSchedule && onToggleSchedule && onDeleteSchedule,
  )

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="font-medium">
          {chatName({ title, memberHandles: members.map((m) => m.handle) })}
        </span>
        {schedulingOn && (
          <Button
            variant="outline"
            size="sm"
            aria-label="Schedules"
            aria-pressed={showSchedules}
            onClick={() => {
              setShowSchedules((v) => !v)
            }}
          >
            <CalendarClock className="size-4" />
            Schedules
            {schedules && schedules.length > 0
              ? ` (${String(schedules.length)})`
              : ''}
          </Button>
        )}
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
      {schedulingOn &&
        showSchedules &&
        onCreateSchedule &&
        onToggleSchedule &&
        onDeleteSchedule && (
          <SchedulesPanel
            schedules={schedules ?? []}
            busy={busy}
            onCreateSchedule={onCreateSchedule}
            onToggleSchedule={onToggleSchedule}
            onDeleteSchedule={onDeleteSchedule}
          />
        )}
      <Messages
        messages={messages}
        working={working}
        seenBy={seenByHandles(members, messages)}
      />
      {onAnswerWidget && onDismissWidget && widgets && widgets.length > 0 && (
        <WidgetStack
          widgets={widgets}
          busy={busy}
          onAnswerWidget={onAnswerWidget}
          onDismissWidget={onDismissWidget}
        />
      )}
      <Composer
        busy={busy}
        onSend={onSend}
        placeholder="Message…  (@mention an agent in a group; Enter to send)"
      />
    </>
  )
}

function SchedulesPanel({
  schedules,
  busy,
  onCreateSchedule,
  onToggleSchedule,
  onDeleteSchedule,
}: {
  schedules: ScheduleItem[]
  busy: boolean
  onCreateSchedule: (input: NewSchedule) => void
  onToggleSchedule: (id: string, enabled: boolean) => void
  onDeleteSchedule: (id: string) => void
}) {
  const [body, setBody] = useState('')
  const [mode, setMode] = useState<'once' | 'repeat'>('once')
  const [at, setAt] = useState('')
  const [every, setEvery] = useState('30')

  function submit() {
    const trimmed = body.trim()
    if (!trimmed) return
    if (mode === 'once') {
      if (!at) return
      onCreateSchedule({ body: trimmed, fireAt: new Date(at).toISOString() })
    } else {
      const minutes = Number.parseInt(every, 10)
      if (Number.isNaN(minutes)) return
      onCreateSchedule({ body: trimmed, intervalMinutes: minutes })
    }
    setBody('')
    setAt('')
  }

  return (
    <div className="border-b bg-muted/20 px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Scheduled messages post themselves into this chat — everyone here can
          see them. A message from you nudges the agents; one from an agent is a
          standing announcement.
        </p>
        {schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No schedules yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {schedules.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">
                    @{s.authorHandle}
                  </span>{' '}
                  {s.body}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {scheduleSummary(s)}
                </span>
                <button
                  type="button"
                  aria-label={`${s.enabled ? 'Disable' : 'Enable'} schedule ${s.id}`}
                  onClick={() => {
                    onToggleSchedule(s.id, !s.enabled)
                  }}
                  className="shrink-0 rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {s.enabled ? 'On' : 'Off'}
                </button>
                <button
                  type="button"
                  aria-label={`Delete schedule ${s.id}`}
                  onClick={() => {
                    onDeleteSchedule(s.id)
                  }}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={inputClass('min-w-40 flex-1')}
            placeholder="Message to schedule…"
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
            }}
          />
          <select
            aria-label="Schedule mode"
            className={selectClass('text-sm')}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value === 'repeat' ? 'repeat' : 'once')
            }}
          >
            <option value="once">Once</option>
            <option value="repeat">Repeat</option>
          </select>
          {mode === 'once' ? (
            <input
              type="datetime-local"
              aria-label="Fire time"
              className={inputClass('text-sm')}
              value={at}
              onChange={(e) => {
                setAt(e.target.value)
              }}
            />
          ) : (
            <label className="flex items-center gap-1 text-sm text-muted-foreground">
              every
              <input
                type="number"
                aria-label="Interval minutes"
                min={5}
                className={inputClass('w-20 text-sm')}
                value={every}
                onChange={(e) => {
                  setEvery(e.target.value)
                }}
              />
              min
            </label>
          )}
          <Button
            size="sm"
            disabled={busy || !body.trim() || (mode === 'once' && !at)}
            onClick={submit}
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The widget stack: the live little views this chat is keeping open, sitting
 * directly above the composer where the next thing you'd touch belongs.
 *
 * It is deliberately a THIN band. One widget is expanded at a time and the rest
 * stay one truncated line each, and the whole band is height-capped and
 * scrollable — so five open widgets can never push the message thread off a
 * phone screen. The stack is a shelf, not a second pane.
 */
function WidgetStack({
  widgets,
  busy,
  onAnswerWidget,
  onDismissWidget,
}: {
  widgets: WidgetItem[]
  busy: boolean
  onAnswerWidget: (widgetId: string, value: string) => void
  onDismissWidget: (widgetId: string) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Which widget this crew member has just answered. The server's own event
  // refreshes the stack a moment later; until then the buttons are spent, so a
  // double tap can't fire a second answer the door would only refuse. (The host
  // usually flips `busy` too, but a rigging component shouldn't need it to
  // avoid double-firing.)
  const [answered, setAnswered] = useState<string[]>([])

  // Forget what's spent the moment the host stops being busy. On a successful
  // answer the widget is gone from the stack anyway; on a FAILED one it's still
  // here, and it has to be answerable again rather than sitting there with dead
  // buttons forever. Compared during render so the first paint after the
  // request settles is already right.
  const [wasBusy, setWasBusy] = useState(busy)
  if (wasBusy !== busy) {
    setWasBusy(busy)
    if (!busy) setAnswered([])
  }

  return (
    <div
      data-testid="widget-stack"
      className="max-h-52 shrink-0 overflow-y-auto border-t bg-muted/20 px-4 py-2"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {widgets.map((widget) => (
          <ChatWidget
            key={widget.id}
            widget={widget}
            expanded={expandedId === widget.id}
            spent={busy || answered.includes(widget.id)}
            onToggle={() => {
              setExpandedId((id) => (id === widget.id ? null : widget.id))
            }}
            onAnswer={(value) => {
              setAnswered((ids) => [...ids, widget.id])
              onAnswerWidget(widget.id, value)
            }}
            onDismiss={() => {
              onDismissWidget(widget.id)
            }}
          />
        ))}
      </div>
    </div>
  )
}

/** The tap-target floor a thumb needs — 2.75rem is 44px. */
const TAP_TARGET = 'min-h-11'

/**
 * One widget, rendered two ways: **compact** (a single truncated line — the
 * question and who asked) and **expanded** (the same line plus its options as
 * tappable buttons). Clicking the compact line expands it; answering hands the
 * value up and the row disappears from the stack when the server says so.
 *
 * A widget whose props don't parse, or whose kind this ship doesn't know, gets
 * an honest tile instead — it says which of the two it is, and it can still be
 * dismissed, so a bad blob is never a dead end you can't clear.
 */
function ChatWidget({
  widget,
  expanded,
  spent,
  onToggle,
  onAnswer,
  onDismiss,
}: {
  widget: WidgetItem
  expanded: boolean
  spent: boolean
  onToggle: () => void
  onAnswer: (value: string) => void
  onDismiss: () => void
}) {
  const parsed = parseProps(widget.kind, widget.props)
  const dismiss = (
    <button
      type="button"
      aria-label={`Dismiss widget ${widget.id}`}
      onClick={onDismiss}
      className={cn(
        'flex shrink-0 items-center justify-center px-3',
        'text-muted-foreground hover:text-destructive',
        TAP_TARGET,
      )}
    >
      <X className="size-4" />
    </button>
  )

  if (!parsed.ok) {
    return (
      <div className="flex items-center gap-1 rounded-lg border border-dashed bg-background px-3 py-1">
        <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 py-1">
          <p className="text-sm">
            {parsed.fault === 'unknown-kind'
              ? 'This ship doesn’t know this widget kind'
              : 'These props don’t parse'}
          </p>
          {/* `detail` carries the technical half either way — the offending
              kind, or which field is wrong. */}
          <p className="truncate text-xs text-muted-foreground">
            {parsed.detail}
          </p>
        </div>
        {dismiss}
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-background">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Open widget ${widget.id}`}
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3 text-left',
            TAP_TARGET,
          )}
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
          {/* Two lines, not one: on a 390px phone a single truncated line left
              about five words of the question readable, which is no question at
              all. Clamped rather than free-flowing so the tile stays a tile. */}
          <span
            data-testid="widget-question"
            className="min-w-0 flex-1 line-clamp-2 py-1 text-sm"
          >
            {parsed.props.question}
          </span>
          {/* Who asked is context, not the point — the first thing to go when
              the screen is narrow, so the question gets the width. */}
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            @{widget.createdByHandle}
          </span>
        </button>
        {dismiss}
      </div>
      {expanded && (
        <div className="flex flex-wrap gap-2 px-3 pb-3">
          {parsed.props.options.map((option) => (
            <Button
              key={option}
              variant="outline"
              disabled={spent}
              onClick={() => {
                onAnswer(option)
              }}
              className={cn('flex-1 basis-32', TAP_TARGET)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function Messages({
  messages,
  working,
  seenBy,
}: Pick<ChatViewProps, 'messages' | 'working'> & { seenBy: string[] }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
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
        {/* A status line, not a message-shaped bubble: the agent is mid-turn,
            which is all this can honestly claim. It may already have posted
            above and still be working; it may finish without posting at all. */}
        {working && (
          <p
            data-testid="agent-working"
            className="flex items-center gap-2 self-start text-xs text-muted-foreground"
          >
            <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-current" />
            {workingLabel(working)}
          </p>
        )}
        {/* Nobody is mid-turn and an agent read the last message without
            answering. Saying so beats an auto-posted "ok!" nobody meant. */}
        {!working && seenBy.length > 0 && (
          <p
            data-testid="agent-seen"
            className="self-start text-xs text-muted-foreground"
          >
            Seen by {seenBy.map((h) => `@${h}`).join(', ')}
          </p>
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
