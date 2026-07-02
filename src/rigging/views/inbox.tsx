import { BellOff, Check, CircleSmall } from 'lucide-react'

import type { InboxItem } from '@hull/notifications/server'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'

// The inbox: what happened on the topics you watch, newest first. Unread
// entries lead with a dot; opening the surface doesn't auto-read — the crew
// clears it deliberately with "Mark all read". Presentational and
// routing-agnostic: the route wires the notifications doors and navigation.
// The entry shape is the door's own InboxItem — one contract, imported down,
// so the two sides can't drift.

export interface InboxViewProps {
  entries: InboxItem[]
  unread: number
  busy: boolean
  onMarkAllRead: () => void
  onOpenIssue: (issueId: string) => void
}

export function InboxView({
  entries,
  unread,
  busy,
  onMarkAllRead,
  onOpenIssue,
}: InboxViewProps) {
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            {unread > 0
              ? `${String(unread)} unread — from the topics you watch.`
              : 'All caught up.'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || unread === 0}
          onClick={onMarkAllRead}
        >
          <Check className="size-4" />
          Mark all read
        </Button>
      </header>
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl p-6">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
              <BellOff className="size-6" />
              <p>Nothing yet. Watch an issue and its news lands here.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  onOpenIssue={onOpenIssue}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </main>
  )
}

function EntryRow({
  entry,
  onOpenIssue,
}: {
  entry: InboxItem
  onOpenIssue: (issueId: string) => void
}) {
  const body = (
    <>
      <CircleSmall
        className={cn(
          'size-3 shrink-0',
          entry.read ? 'text-transparent' : 'fill-sky-500 text-sky-500',
        )}
        aria-label={entry.read ? undefined : 'unread'}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          !entry.read && 'font-medium',
        )}
      >
        {entry.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {entry.at.slice(0, 16).replace('T', ' ')}
      </span>
    </>
  )

  if (entry.issueId === null) {
    return (
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => {
        onOpenIssue(entry.issueId ?? '')
      }}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
    >
      {body}
    </button>
  )
}
