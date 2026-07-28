import { useEffect, useRef } from 'react'

import { cn } from '@rigging/lib/utils'
import { ScrollArea } from '@rigging/components/ui/scroll-area'

// The thread: the clean message transcript, the live "working…" line, and the
// quiet facts around it (who has SEEN the last message, what an empty thread
// says for itself). Presentational — data in, nothing out; an agent's tool
// calls stay in the Agents view.

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

/**
 * What a chat with nothing said in it says for itself.
 *
 * A brand-new thread used to be a blank rectangle — the chat list, the canvas
 * and a canvas page all have an empty state and the one you actually land in
 * didn't, so the first thing a new crew member saw read as a broken ship. It's
 * also the one moment somebody will read an explanation of the two surfaces, so
 * that's what it spends its words on — but only where it's TRUE: a chat with no
 * agents in it can't promise anything about what an agent will do. Pure and
 * exported so the wording is tested.
 */
export function emptyThreadLine(members: ChatMemberItem[]): string {
  const hasAgent = members.some((m) => m.type === 'agent')
  return hasAgent
    ? 'Say something to start it off. The agents in here answer, put questions up for you to tap, and pin readouts to the canvas.'
    : 'Say something to start it off.'
}

/**
 * The live indicator, as its own component because it has two homes: inside the
 * thread where it belongs, and directly above the composer when a phone is
 * showing the canvas instead. One definition, so the two can't say it
 * differently.
 */
export function WorkingLine({
  working,
}: {
  working: { handle: string; line: string }
}) {
  return (
    <p
      data-testid="agent-working"
      className="flex items-center gap-2 self-start text-xs text-muted-foreground"
    >
      <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-current" />
      {workingLabel(working)}
    </p>
  )
}

export function Messages({
  members,
  messages,
  working,
  seenBy,
}: {
  members: ChatMemberItem[]
  messages: ChatMsg[]
  /** An agent is mid-reply: show a live placeholder until its message lands. */
  working: { handle: string; line: string } | null
  seenBy: string[]
}) {
  // Keep the newest thing in view — the Agents transcript has always done this
  // and the front door never did, so answering a widget could post your own
  // message somewhere you couldn't see it. Re-runs on a new message and on the
  // working line coming or going, which are the only things that grow the thread.
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, working])

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-6">
        {/* A chat you just made is the first thing a new crew member sees, and
            an unexplained blank rectangle reads as a broken ship. */}
        {messages.length === 0 && !working && (
          <div
            data-testid="thread-empty"
            className="my-auto text-center text-sm text-muted-foreground"
          >
            <p className="font-medium text-foreground">Nothing said yet</p>
            <p>{emptyThreadLine(members)}</p>
          </div>
        )}
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
        {working && <WorkingLine working={working} />}
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
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
