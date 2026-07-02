import { useState } from 'react'
import {
  ArrowLeft,
  Bell,
  BellOff,
  GitBranch,
  Hammer,
  Loader2,
  Send,
} from 'lucide-react'

import type { IssueThread, ThreadEntry } from '@hull/issues/server'
import type { IssueStatus } from '@hull/issues/schema'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'

// The issue thread: body, the merged comment + status-change timeline, a
// composer, and the status controls. Presentational and routing-agnostic; the
// route wires it to the issues service and feeds it live updates via useShipLog.

export interface IssueThreadViewProps {
  thread: IssueThread
  busy: boolean
  /** Is the current actor watching this issue (notified of its news)? */
  watching: boolean
  onBack: () => void
  onComment: (body: string) => void
  onSetStatus: (status: string) => void
  onToggleWatch: () => void
}

const STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'Open',
  building: 'Building',
  done: 'Done',
  closed: 'Closed',
}

export function IssueThreadView({
  thread,
  busy,
  watching,
  onBack,
  onComment,
  onSetStatus,
  onToggleWatch,
}: IssueThreadViewProps) {
  const terminal = thread.status === 'done' || thread.status === 'closed'
  return (
    <main className="flex h-screen flex-col">
      <header className="flex flex-col gap-2 border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label="Back to the board"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {thread.title}
          </h1>
          <Button
            variant={watching ? 'default' : 'outline'}
            size="sm"
            disabled={busy}
            onClick={onToggleWatch}
          >
            {watching ? (
              <BellOff className="size-4" />
            ) : (
              <Bell className="size-4" />
            )}
            {watching ? 'Unwatch' : 'Watch'}
          </Button>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            #{thread.nano}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 pl-10 text-xs text-muted-foreground">
          <span>by @{thread.authorHandle}</span>
          <StatusBadge status={thread.status} />
          {thread.branchName && (
            <span className="flex items-center gap-1 font-mono">
              <GitBranch className="size-3" />
              {thread.branchName}
            </span>
          )}
        </div>
        {thread.status === 'building' && thread.statusLine && (
          <p className="flex items-center gap-2 pl-10 font-mono text-xs text-amber-600">
            <Hammer className="size-3 animate-pulse" />
            {thread.statusLine}
          </p>
        )}
        <StatusControls
          status={thread.status}
          busy={busy}
          onSetStatus={onSetStatus}
        />
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
          {thread.body && (
            <p className="whitespace-pre-wrap rounded-lg border bg-card p-3 leading-relaxed">
              {thread.body}
            </p>
          )}
          {thread.entries.map((entry) => (
            <ThreadEntryView key={entry.id} entry={entry} />
          ))}
        </div>
      </ScrollArea>

      {!terminal && <Composer busy={busy} onComment={onComment} />}
    </main>
  )
}

function StatusBadge({ status }: { status: IssueStatus }) {
  const tint: Record<IssueStatus, string> = {
    open: 'bg-sky-500/15 text-sky-600',
    building: 'bg-amber-500/15 text-amber-600',
    done: 'bg-emerald-500/15 text-emerald-600',
    closed: 'bg-muted text-muted-foreground',
  }
  return (
    <span className={cn('rounded-full px-2 py-0.5 font-medium', tint[status])}>
      {STATUS_LABEL[status]}
    </span>
  )
}

/**
 * The legal human controls, mirroring the state machine: open→building / build,
 * building→open / pause, and close from either. Done/closed are terminal, so no
 * controls show.
 */
function StatusControls({
  status,
  busy,
  onSetStatus,
}: {
  status: IssueStatus
  busy: boolean
  onSetStatus: (status: string) => void
}) {
  if (status === 'done' || status === 'closed') return null
  return (
    <div className="flex flex-wrap gap-2 pl-10">
      {status === 'open' && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            onSetStatus('building')
          }}
        >
          <Hammer className="size-4" />
          Build it
        </Button>
      )}
      {status === 'building' && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            onSetStatus('open')
          }}
        >
          Pause
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          onSetStatus('close')
        }}
      >
        Close
      </Button>
    </div>
  )
}

function ThreadEntryView({ entry }: { entry: ThreadEntry }) {
  if (entry.kind === 'status') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>
          @{entry.authorHandle} moved {entry.from} → {entry.to}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
      <span className="text-xs font-medium text-muted-foreground">
        @{entry.authorHandle}
      </span>
      <p className="whitespace-pre-wrap leading-relaxed">{entry.body}</p>
    </div>
  )
}

function Composer({
  busy,
  onComment,
}: Pick<IssueThreadViewProps, 'busy' | 'onComment'>) {
  const [text, setText] = useState('')

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    onComment(trimmed)
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
          placeholder="Comment…  (Enter to send, Shift+Enter for a newline)"
          rows={1}
          className="max-h-40 min-h-[2.5rem] resize-none"
        />
        <Button
          onClick={submit}
          disabled={busy || !text.trim()}
          aria-label="Add comment"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </div>
    </div>
  )
}
