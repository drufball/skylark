import { useState, type ComponentType, type ReactNode } from 'react'
import {
  ArrowUpRight,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Users,
} from 'lucide-react'

import type { CanvasBox } from '@hull/chat/widgets'
import { useIsMobile } from '@rigging/lib/use-is-mobile'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Composer } from '@rigging/components/composer'
import { CollapsibleSidebar } from '@rigging/components/collapsible-sidebar'
import {
  WidgetCanvas,
  type CanvasPageItem,
  type CanvasWidgetItem,
} from '@rigging/widgets/canvas'
import { TAP_TARGET } from '@rigging/lib/tap-target'
import { WidgetStack, type WidgetItem } from '@rigging/widgets/stack'
import {
  SchedulesButton,
  SchedulesPanel,
  type ChatSchedules,
} from './chat-schedules'
import {
  Messages,
  seenByHandles,
  WorkingLine,
  type ChatMemberItem,
  type ChatMsg,
} from './chat-thread'
import { Roster, type CrewMember } from './chat-roster'
import { Empty, NewChat } from './chat-compose'

// The front door: chat between the crew — humans and agents. Participant-focused
// (you keep messaging the same people with new tasks), so the sidebar names a
// chat by its members when it has no title, and opens your most recent one.
// Presentational and routing-agnostic: data in, callbacks out. This file is the
// ASSEMBLY — the chat list and the header that lays the panels out; the panels
// themselves live beside it (chat-thread, chat-roster, chat-schedules,
// chat-compose), each behind one narrow interface.

export interface ChatListItem {
  id: string
  title: string | null
  memberHandles: string[]
}

// The view's public contract, re-exported so the host imports one module —
// the types live with the panel that owns them.
export type { ChatMemberItem, ChatMsg }
export type { CrewMember }
export type { ChatSchedules }
export type { NewSchedule, ScheduleItem } from './chat-schedules'

/**
 * The chat's **canvas** — pages of widgets the crew arranged, shown BESIDE the
 * thread rather than as a destination of its own. The whole point is that you
 * never leave the conversation to look at the thing you built, so there is no
 * third route and no pane that retargets independently: this is one chat's
 * canvas, in that chat. The shape mirrors `WidgetCanvas`'s own props (minus
 * `busy`), which is where all of it goes.
 */
export interface ChatCanvas {
  pages: CanvasPageItem[]
  widgets: CanvasWidgetItem[]
  /** The page THIS viewer has open — per person, persisted by the host. */
  activePageId: string | null
  onSelectPage: (pageId: string) => void
  onNewPage: (title: string) => void
  onRenamePage: (pageId: string, title: string) => void
  onRemovePage: (pageId: string) => void
  /**
   * Arrange a widget on a page — a drag, a resize, or a pin from the stack.
   * The box is PARTIAL because "put this somewhere sensible" is a real request:
   * with no corner the service finds the first free slot rather than dropping
   * the tile on top of one already there.
   */
  onPlaceWidget: (
    widgetId: string,
    box: Partial<CanvasBox> & { pageId: string },
  ) => void
  onStackWidget: (widgetId: string) => void
  onAnswerWidget: (widgetId: string, value: string) => void
  /**
   * Pin a canvas widget onto the viewer's own HOME canvas — a pointer at it,
   * never a copy, and never a move: the widget goes on living in this chat.
   * Optional, so a host with no home surface simply doesn't draw the control.
   */
  onPinHome?: (widgetId: string) => void
}

/**
 * The turn-shaped widget shelf above the composer: the active chat's open
 * widgets, already in stack order — `kind` + opaque `props`, exactly as the
 * rows hold them. The stack resolves each one through the widget catalog
 * (`@rigging/widgets`), so this view knows no kind by name and adding one
 * never touches it.
 */
export interface ChatStack {
  widgets: WidgetItem[]
  onAnswerWidget: (widgetId: string, value: string) => void
  onDismissWidget: (widgetId: string) => void
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
  schedules?: ChatSchedules
  /** The widget shelf (optional — a host with no widget door shows no shelf). */
  stack?: ChatStack
  /** The canvas beside the thread (optional — a thread-only host omits it). */
  canvas?: ChatCanvas
  /**
   * The richer view this chat is the ROOM for, if it's one of the ship's
   * default rooms (`rigging/rooms`) — the board behind the `issue-list` tile,
   * the browser behind the `files` tile. Those surfaces left the rail when the
   * rooms arrived; the room is now the way in, and a view nothing links to is a
   * view that gets deleted by accident. Null for an ordinary chat.
   */
  viewLink?: { to: string; label: string } | null
  /** The router's Link, injected — this view stays router-agnostic. */
  Link?: ComponentType<{
    to: string
    className?: string
    children: ReactNode
  }>
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
 * What the composer's placeholder says. Mobile-first, and shorter than it was for
 * two reasons: the old copy wrapped to three lines in a one-row textarea on a
 * 390px phone, and it advised "Enter to send" to somebody holding a touch
 * keyboard, where Enter is a newline.
 *
 * The @mention hint is kept only where it's TRUE. In a 1:1 the agent always
 * answers, so telling you to mention it is wrong information taking up the whole
 * field; in a group only mentioned agents reply, which is the one thing about
 * this composer you couldn't guess. Pure and exported so the wording is tested.
 */
export function composerPlaceholder(members: ChatMemberItem[]): string {
  const agents = members.filter((m) => m.type === 'agent').length
  const humans = members.filter((m) => m.type === 'human').length
  const group = agents > 1 || humans > 1
  return group ? 'Message… @mention an agent' : 'Message…'
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
          // Keyed by the chat: switching conversations resets the panel state
          // this component holds (which surface you're on, whether the canvas
          // pane is open), which belongs to the chat you were in, not to you.
          <ActiveChat key={props.activeId} {...props} />
        ) : (
          <Empty onNew={props.onNew} />
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
  stack,
  canvas,
  viewLink,
  Link,
}: ChatViewProps) {
  const memberIds = new Set(members.map((m) => m.userId))
  const addable = crew.filter((c) => !memberIds.has(c.id))
  const [showSchedules, setShowSchedules] = useState(false)
  // Whether the header's overflow is unfolded. Only ever read on a phone: a
  // desktop header is one row with room for everything, so there's nothing to
  // fold there and no overflow control to draw.
  const [menuOpen, setMenuOpen] = useState(false)

  const isMobile = useIsMobile()
  const canvasOn = Boolean(canvas)
  const pages = canvas?.pages ?? []
  // Which surface a PHONE is showing, where the two can't both fit. Desktop
  // shows them together, so this is only ever read below the breakpoint.
  const [surface, setSurface] = useState<'thread' | 'canvas'>('thread')
  // Whether the desktop canvas pane is open. Null means "haven't chosen" — a
  // chat that HAS a canvas opens with it up, one that doesn't keeps the whole
  // width for the thread until you ask.
  const [paneOpen, setPaneOpen] = useState<boolean | null>(null)
  const canvasVisible = isMobile
    ? canvasOn && surface === 'canvas'
    : canvasOn && (paneOpen ?? pages.length > 0)
  const threadVisible = !isMobile || surface === 'thread'
  // Where a pinned stack widget lands: the page you have open, else the first.
  const landingPage =
    pages.find((p) => p.id === canvas?.activePageId)?.id ?? pages.at(0)?.id
  // How many widgets are waiting above the composer. Only interesting while a
  // phone is on the canvas, where the shelf itself isn't on screen.
  const waiting = stack?.widgets.length ?? 0

  return (
    <>
      {/* ONE row on a phone, one on a desktop pane.

          #cse5 took this header from four rows down to two and #cse8 spent the
          slack again: the name, People, the room's link, the surface toggle and
          Schedules all shared 390px, one control away from wrapping to three.
          Shaving pixels off each of them is a debt you pay every slice, so the
          phone row now has a FIXED shape instead — the name, the two things
          that carry STATE (which surface you're on, and how many widgets are
          waiting on the other one), and a single overflow. Everything else
          lives behind the overflow, and so does the next thing somebody adds,
          which is the point: the row can't grow. */}
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 md:px-4">
        <span className="min-w-0 flex-1 truncate font-medium">
          {chatName({ title, memberHandles: members.map((m) => m.handle) })}
        </span>
        {/* The way through to the surface this room replaced — on a desktop
            pane, where it fits beside everything else. On a phone it's the
            first thing in the overflow. */}
        {!isMobile && viewLink && Link && (
          <Link
            to={viewLink.to}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-md border px-3 text-sm',
              'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              TAP_TARGET,
            )}
          >
            {viewLink.label}
            <ArrowUpRight className="size-4" />
          </Link>
        )}
        {canvasOn &&
          (isMobile ? (
            // A phone can't show both, so it gets a plain either/or — and the
            // Thread half is always right there, so the canvas can never be a
            // place you get stuck. It carries the count of what's waiting in the
            // shelf, which the canvas surface doesn't show.
            <div className="flex overflow-hidden rounded-md border">
              {(['thread', 'canvas'] as const).map((which) => {
                const badge =
                  which === 'thread' && !threadVisible && waiting > 0
                return (
                  <button
                    key={which}
                    type="button"
                    aria-pressed={surface === which}
                    aria-label={
                      badge ? `Thread — ${String(waiting)} waiting` : undefined
                    }
                    onClick={() => {
                      setSurface(which)
                    }}
                    className={cn(
                      'flex items-center gap-1 px-2.5 text-sm capitalize',
                      TAP_TARGET,
                      surface === which && 'bg-accent text-accent-foreground',
                    )}
                  >
                    {which}
                    {badge && (
                      <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                        {waiting}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              aria-label="Canvas"
              aria-pressed={canvasVisible}
              onClick={() => {
                setPaneOpen(!canvasVisible)
              }}
            >
              <LayoutGrid className="size-4" />
              Canvas
            </Button>
          ))}
        {!isMobile && schedules && (
          <SchedulesButton
            count={schedules.items?.length ?? 0}
            open={showSchedules}
            onToggle={() => {
              setShowSchedules((v) => !v)
            }}
          />
        )}
        {!isMobile && (
          <Roster
            members={members}
            addable={addable}
            thumb={false}
            onAddMember={onAddMember}
            onRemoveMember={onRemoveMember}
          />
        )}
        {isMobile && (
          <Button
            variant="outline"
            size="sm"
            className={cn('shrink-0 px-3', TAP_TARGET)}
            aria-label="More"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((v) => !v)
            }}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      </header>
      {/* The overflow, unfolded. A panel under the header rather than a popover:
          it's the same shape the Schedules panel already uses, it needs no
          positioning maths at 390px, and there is nothing here a thumb has to
          hit twice. */}
      {isMobile && menuOpen && (
        <div className="flex flex-col gap-2 border-b bg-muted/20 px-3 py-2">
          {(viewLink ?? schedules) && (
            <div className="flex flex-wrap items-center gap-2">
              {viewLink && Link && (
                <Link
                  to={viewLink.to}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-md border bg-background px-3 text-sm',
                    'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    TAP_TARGET,
                  )}
                >
                  {viewLink.label}
                  <ArrowUpRight className="size-4" />
                </Link>
              )}
              {schedules && (
                <SchedulesButton
                  count={schedules.items?.length ?? 0}
                  open={showSchedules}
                  onToggle={() => {
                    setShowSchedules((v) => !v)
                  }}
                />
              )}
            </div>
          )}
          <Roster
            members={members}
            addable={addable}
            thumb
            onAddMember={onAddMember}
            onRemoveMember={onRemoveMember}
          />
        </div>
      )}
      {schedules && showSchedules && (
        <SchedulesPanel schedules={schedules} busy={busy} />
      )}
      {/* The thread and the canvas, side by side on a desktop pane and one at a
          time on a phone — but always INSIDE the chat. The composer sits under
          both, so looking at the canvas never costs you the ability to say
          something about what you see. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {threadVisible && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Messages
              members={members}
              messages={messages}
              working={working}
              seenBy={seenByHandles(members, messages)}
            />
          </div>
        )}
        {canvasVisible && canvas && (
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col',
              threadVisible && 'border-l',
            )}
          >
            {/* The group mirrors WidgetCanvas's props on purpose — the spread
                IS the wiring. */}
            <WidgetCanvas {...canvas} busy={busy} />
          </div>
        )}
      </div>
      {/* The status line lives in the thread, which a phone on the canvas isn't
          showing — so an agent mid-turn went silent on the device this feature
          is aimed at. It follows the composer instead, which is under both. */}
      {!threadVisible && working && (
        <div className="shrink-0 border-t px-4 py-1.5">
          <WorkingLine working={working} />
        </div>
      )}
      {/* The shelf is turn-shaped, so it belongs with the thread. On a phone
          showing the canvas it was taking a quarter of the screen off the
          surface you'd deliberately switched to; the Thread toggle carries the
          count instead, so nothing an agent asked for goes quiet. */}
      {threadVisible && stack && stack.widgets.length > 0 && (
        <WidgetStack
          widgets={stack.widgets}
          busy={busy}
          onAnswerWidget={stack.onAnswerWidget}
          onDismissWidget={stack.onDismissWidget}
          // Only when there IS a page to send it to. A pin button on a chat
          // with no canvas would be an affordance pointing nowhere.
          onPinWidget={
            canvas && landingPage
              ? (widgetId) => {
                  // No corner on purpose — see onPlaceWidget's note.
                  canvas.onPlaceWidget(widgetId, { pageId: landingPage })
                }
              : undefined
          }
        />
      )}
      <Composer
        busy={busy}
        onSend={onSend}
        placeholder={composerPlaceholder(members)}
      />
    </>
  )
}
