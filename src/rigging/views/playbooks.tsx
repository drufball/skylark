import { useState } from 'react'
import { BookOpen, Plus } from 'lucide-react'

import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'

// The playbooks editor: issue-handling strategies as data. A playbook is a
// roster of agent crew plus the entrypoint that starts the work — pick the
// crew, pick who goes first, name it. Presentational and routing-agnostic;
// the agents route wires it to the issues service.

export interface PlaybookSummary {
  id: string
  name: string
  description: string
  memberIds: string[]
  memberHandles: string[]
  entrypointId: string
  entrypointHandle: string
}

/** An agent crew member the roster picker offers. */
export interface RosterAgent {
  id: string
  handle: string
}

export interface PlaybookFormValue {
  name: string
  description: string
  memberIds: string[]
  entrypointId: string
}

export interface PlaybooksProps {
  playbooks: PlaybookSummary[]
  agents: RosterAgent[]
  saving: boolean
  onSave: (value: PlaybookFormValue) => void
}

export function Playbooks({
  playbooks,
  agents,
  saving,
  onSave,
}: PlaybooksProps) {
  // The playbook being edited (by id), or 'new' for the create form, or null.
  const [editing, setEditing] = useState<string | null>(null)
  const editingPlaybook = playbooks.find((p) => p.id === editing)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl p-6">
        <header className="mb-4">
          <h2 className="text-base font-semibold">Playbooks</h2>
          <p className="text-sm text-muted-foreground">
            How an issue gets worked: which agents are on it, and who starts.
            Pick one when you file an issue.
          </p>
        </header>

        <div className="flex flex-col gap-2">
          {playbooks.map((p) =>
            editing === p.id ? (
              <PlaybookForm
                key={p.id}
                initial={p}
                agents={agents}
                saving={saving}
                nameLocked
                onCancel={() => {
                  setEditing(null)
                }}
                onSave={(value) => {
                  onSave(value)
                  setEditing(null)
                }}
              />
            ) : (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setEditing(p.id)
                }}
                className={cn(
                  'flex flex-col gap-1 rounded-lg border bg-card p-3 text-left',
                  'hover:border-accent-foreground/20 hover:bg-accent/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{p.name}</span>
                </div>
                {p.description && (
                  <p className="pl-6 text-sm text-muted-foreground">
                    {p.description}
                  </p>
                )}
                <p className="pl-6 text-xs text-muted-foreground">
                  crew @{p.memberHandles.join(', @')} · starts with @
                  {p.entrypointHandle}
                </p>
              </button>
            ),
          )}
        </div>

        <div className="mt-4">
          {editing === 'new' ? (
            <PlaybookForm
              agents={agents}
              saving={saving}
              onCancel={() => {
                setEditing(null)
              }}
              onSave={(value) => {
                onSave(value)
                setEditing(null)
              }}
            />
          ) : (
            !editingPlaybook && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditing('new')
                }}
              >
                <Plus className="size-4" />
                New playbook
              </Button>
            )
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function PlaybookForm({
  initial,
  agents,
  saving,
  nameLocked = false,
  onCancel,
  onSave,
}: {
  initial?: PlaybookSummary
  agents: RosterAgent[]
  saving: boolean
  /** Editing keeps the name — it's the upsert key issues resolve through. */
  nameLocked?: boolean
  onCancel: () => void
  onSave: (value: PlaybookFormValue) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [memberIds, setMemberIds] = useState<string[]>(initial?.memberIds ?? [])
  const [entrypointId, setEntrypointId] = useState(initial?.entrypointId ?? '')

  const valid =
    name.trim().length > 0 &&
    memberIds.length > 0 &&
    memberIds.includes(entrypointId)

  function toggleMember(id: string) {
    setMemberIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((m) => m !== id)
        : [...prev, id]
      // Dropping the entrypoint from the roster clears the entrypoint pick.
      if (!next.includes(entrypointId)) setEntrypointId('')
      return next
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <input
        autoFocus={!nameLocked}
        value={name}
        disabled={nameLocked}
        onChange={(e) => {
          setName(e.target.value)
        }}
        placeholder="Name (e.g. research)"
        aria-label="Playbook name"
        className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-accent-foreground/30 disabled:opacity-60"
      />
      <Textarea
        value={description}
        onChange={(e) => {
          setDescription(e.target.value)
        }}
        placeholder="What this strategy is for (optional)"
        rows={2}
        className="resize-none"
      />
      <fieldset>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Crew
        </legend>
        <div className="flex flex-wrap gap-2">
          {agents.map((a) => (
            <label
              key={a.id}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-sm',
                memberIds.includes(a.id) && 'border-accent-foreground/40',
              )}
            >
              <input
                type="checkbox"
                checked={memberIds.includes(a.id)}
                onChange={() => {
                  toggleMember(a.id)
                }}
              />
              @{a.handle}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Starts with
        </span>
        <select
          value={entrypointId}
          onChange={(e) => {
            setEntrypointId(e.target.value)
          }}
          aria-label="Entrypoint agent"
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          <option value="">pick a member…</option>
          {agents
            .filter((a) => memberIds.includes(a.id))
            .map((a) => (
              <option key={a.id} value={a.id}>
                @{a.handle}
              </option>
            ))}
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={saving || !valid}
          onClick={() => {
            onSave({
              name: name.trim(),
              description: description.trim(),
              memberIds,
              entrypointId,
            })
          }}
        >
          Save playbook
        </Button>
      </div>
    </div>
  )
}
