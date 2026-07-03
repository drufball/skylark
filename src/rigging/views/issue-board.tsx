import { useState } from 'react'
import {
  CheckCircle2,
  CircleDot,
  Hammer,
  MessageSquare,
  Plus,
  XCircle,
} from 'lucide-react'

import type { BoardIssue } from '@hull/issues/server'
import type { IssueStatus } from '@hull/issues/schema'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'

// The board: issues grouped by status, forum-like — open discussions up top,
// then building, then the closed-out ones. Presentational and routing-agnostic;
// the route wires it to the issues service and the address bar. Live updates
// arrive by the route re-running its loader on a ship's-log event.

/** A playbook option the composer offers — how the issue will be worked. */
export interface PlaybookOption {
  id: string
  name: string
  description: string
  /** The ship default — what filing without an explicit choice means. */
  isDefault: boolean
}

export interface IssueBoardViewProps {
  issues: BoardIssue[]
  playbooks: PlaybookOption[]
  busy: boolean
  onOpen: (title: string, body: string, playbookId: string | undefined) => void
  onSelect: (id: string) => void
}

/** The display order of the status groups — discussions first, archive last. */
const GROUPS: { status: IssueStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'building', label: 'Building' },
  { status: 'done', label: 'Done' },
  { status: 'closed', label: 'Closed' },
]

const STATUS_ICON: Record<IssueStatus, typeof CircleDot> = {
  open: CircleDot,
  building: Hammer,
  done: CheckCircle2,
  closed: XCircle,
}

const STATUS_TINT: Record<IssueStatus, string> = {
  open: 'text-sky-500',
  building: 'text-amber-500',
  done: 'text-emerald-500',
  closed: 'text-muted-foreground',
}

export function IssueBoardView({
  issues,
  playbooks,
  busy,
  onOpen,
  onSelect,
}: IssueBoardViewProps) {
  return (
    <main className="flex h-screen flex-col">
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Issues</h1>
        <p className="text-sm text-muted-foreground">
          File work for the crew — or hand it to a building agent.
        </p>
      </header>
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl p-6">
          <NewIssue busy={busy} playbooks={playbooks} onOpen={onOpen} />
          {issues.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No issues yet. Open the first one above.
            </p>
          ) : (
            GROUPS.map(({ status, label }) => {
              const group = issues.filter((i) => i.status === status)
              if (group.length === 0) return null
              return (
                <section key={status} className="mt-8 first:mt-6">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {label} · {group.length}
                  </h2>
                  <div className="flex flex-col gap-2">
                    {group.map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                </section>
              )
            })
          )}
        </div>
      </ScrollArea>
    </main>
  )
}

function IssueCard({
  issue,
  onSelect,
}: {
  issue: BoardIssue
  onSelect: (id: string) => void
}) {
  const Icon = STATUS_ICON[issue.status]
  return (
    <button
      type="button"
      onClick={() => {
        onSelect(issue.id)
      }}
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-card p-3 text-left',
        'hover:border-accent-foreground/20 hover:bg-accent/40',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn('size-4 shrink-0', STATUS_TINT[issue.status])} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {issue.title}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          #{issue.nano}
        </span>
      </div>
      <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground">
        <span>@{issue.authorHandle}</span>
        {issue.commentCount > 0 && (
          <span className="flex items-center gap-1">
            <MessageSquare className="size-3" />
            {issue.commentCount}
          </span>
        )}
      </div>
      {issue.status === 'building' && issue.statusLine && (
        <p className="truncate pl-6 font-mono text-xs text-amber-600">
          {issue.statusLine}
        </p>
      )}
    </button>
  )
}

function NewIssue({
  busy,
  playbooks,
  onOpen,
}: Pick<IssueBoardViewProps, 'busy' | 'playbooks' | 'onOpen'>) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  // '' = the ship default (the build playbook), resolved server-side.
  const [playbookId, setPlaybookId] = useState('')
  const [open, setOpen] = useState(false)

  function submit() {
    const t = title.trim()
    if (!t || busy) return
    onOpen(t, body.trim(), playbookId || undefined)
    setTitle('')
    setBody('')
    setPlaybookId('')
    setOpen(false)
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true)
        }}
      >
        <Plus className="size-4" />
        New issue
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <input
        autoFocus
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
        }}
        placeholder="Title"
        className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-accent-foreground/30"
      />
      <Textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
        }}
        placeholder="Describe the work (optional)"
        rows={3}
        className="resize-none"
      />
      {playbooks.length > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Playbook
          </span>
          <select
            value={playbookId}
            onChange={(e) => {
              setPlaybookId(e.target.value)
            }}
            aria-label="Playbook"
            className="rounded-md border bg-background px-2 py-1 text-sm"
          >
            <option value="">
              {playbooks.find((p) => p.isDefault)?.name ?? 'build'} (default)
            </option>
            {playbooks
              .filter((p) => !p.isDefault)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.description ? ` — ${p.description}` : ''}
                </option>
              ))}
          </select>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false)
          }}
        >
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy || !title.trim()}>
          Open issue
        </Button>
      </div>
    </div>
  )
}
