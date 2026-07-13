import { useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'

import type { BoardIssue } from '@hull/issues/server'
import { computeBuildActivity } from '@hull/issues/activity'
import { cn } from '@rigging/lib/utils'
import { useNow } from '@rigging/lib/use-now'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'
import { selectClass } from '@rigging/components/ui/input'
import {
  activityTint,
  ISSUE_STATUS_META,
  ISSUE_STATUS_ORDER,
} from '@rigging/lib/issue-status-meta'

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

export function IssueBoardView({
  issues,
  playbooks,
  busy,
  onOpen,
  onSelect,
}: IssueBoardViewProps) {
  return (
    <main className="flex h-full flex-col overflow-hidden">
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Issues</h1>
        <p className="text-sm text-muted-foreground">
          File work for the crew — or hand it to a building agent.
        </p>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl p-6">
          <NewIssue busy={busy} playbooks={playbooks} onOpen={onOpen} />
          {issues.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No issues yet. Open the first one above.
            </p>
          ) : (
            ISSUE_STATUS_ORDER.map((status) => {
              const { label } = ISSUE_STATUS_META[status]
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
  const { icon: Icon, tint } = ISSUE_STATUS_META[issue.status]
  const now = useNow()
  const activity =
    issue.status === 'building'
      ? computeBuildActivity({
          sessionRunning: issue.sessionRunning,
          statusLine: issue.statusLine,
          statusLineAt: issue.statusLineAt,
          awaitingBackground: issue.awaitingBackground,
          now,
        })
      : null
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
        <Icon className={cn('size-4 shrink-0', tint)} />
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
      {activity && (
        <p
          className={cn(
            'truncate pl-6 font-mono text-xs',
            activityTint(activity.state),
          )}
        >
          {activity.label}
        </p>
      )}
    </button>
  )
}

/** The empty-value option's label: the default playbook, described. */
function defaultPlaybookLabel(playbooks: PlaybookOption[]): string {
  const d = playbooks.find((p) => p.isDefault)
  if (!d) return 'build (default)'
  return `${d.name}${d.description ? ` — ${d.description}` : ''} (default)`
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
            className={selectClass()}
          >
            {/* The default explains itself like every other option — it's the
                one whose behaviour a crewmate most needs to trust on faith. */}
            <option value="">{defaultPlaybookLabel(playbooks)}</option>
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
