import { useState } from 'react'
import { BookOpen, Bot, Plus, User } from 'lucide-react'

import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'

// The Crew tab: the ship's roster, and where named agents are made. A named
// agent is a full crew member — a users row — with a profile (how its sessions
// boot) and a persistent memory folder in the shared files (what it knows).
// Presentational and routing-agnostic: the route wires the doors and the
// address bar.

export interface CrewMemberSummary {
  id: string
  handle: string
  displayName: string
  type: 'human' | 'agent'
  profileId: string | null
}

export interface CrewProfileOption {
  id: string
  name: string
}

export interface AgentCrewProps {
  crew: CrewMemberSummary[]
  profiles: CrewProfileOption[]
  saving: boolean
  onCreate: (input: {
    handle: string
    displayName: string
    profileId: string | null
  }) => void
  onUpdate: (input: {
    userId: string
    displayName?: string
    profileId?: string
  }) => void
  /** Open an agent's memory index in the Files surface. */
  onOpenMemory: (handle: string) => void
}

export function AgentCrew({
  crew,
  profiles,
  saving,
  onCreate,
  onUpdate,
  onOpenMemory,
}: AgentCrewProps) {
  const agents = crew.filter((m) => m.type === 'agent')
  const humans = crew.filter((m) => m.type === 'human')

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl p-6">
        <NewAgent profiles={profiles} saving={saving} onCreate={onCreate} />

        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Agents · {agents.length}
          </h2>
          <div className="flex flex-col gap-2">
            {agents.map((member) => (
              <AgentCard
                key={member.id}
                member={member}
                profiles={profiles}
                saving={saving}
                onUpdate={onUpdate}
                onOpenMemory={onOpenMemory}
              />
            ))}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Humans · {humans.length}
          </h2>
          <div className="flex flex-col gap-2">
            {humans.map((member) => (
              <div
                key={member.id}
                className="flex items-center gap-2 rounded-lg border bg-card p-3"
              >
                <User className="size-4 text-muted-foreground" />
                <span className="font-medium">{member.displayName}</span>
                <span className="text-sm text-muted-foreground">
                  @{member.handle}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}

function AgentCard({
  member,
  profiles,
  saving,
  onUpdate,
  onOpenMemory,
}: {
  member: CrewMemberSummary
  profiles: CrewProfileOption[]
  saving: boolean
  onUpdate: AgentCrewProps['onUpdate']
  onOpenMemory: (handle: string) => void
}) {
  const [name, setName] = useState(member.displayName)

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
          }}
          onBlur={() => {
            const trimmed = name.trim()
            if (trimmed && trimmed !== member.displayName) {
              onUpdate({ userId: member.id, displayName: trimmed })
            }
          }}
          aria-label={`Display name for @${member.handle}`}
          className="w-40 rounded-md border bg-background px-2 py-1 text-sm font-medium outline-none focus:border-accent-foreground/30"
        />
        <span className="text-sm text-muted-foreground">@{member.handle}</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onOpenMemory(member.handle)
          }}
        >
          <BookOpen className="size-4" />
          Memory
        </Button>
      </div>
      <label className="flex items-center gap-2 pl-6 text-sm text-muted-foreground">
        Profile
        <select
          value={member.profileId ?? ''}
          disabled={saving}
          onChange={(e) => {
            if (e.target.value) {
              onUpdate({ userId: member.id, profileId: e.target.value })
            }
          }}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          <option value="" disabled>
            (none)
          </option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

function NewAgent({
  profiles,
  saving,
  onCreate,
}: Pick<AgentCrewProps, 'profiles' | 'saving' | 'onCreate'>) {
  const [open, setOpen] = useState(false)
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [profileId, setProfileId] = useState('')

  function submit() {
    const h = handle.trim().toLowerCase()
    const n = displayName.trim()
    if (!h || !n || saving) return
    onCreate({ handle: h, displayName: n, profileId: profileId || null })
    setHandle('')
    setDisplayName('')
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
        New agent
      </Button>
    )
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="flex gap-2">
        <input
          autoFocus
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value)
          }}
          placeholder="handle (e.g. scout)"
          className="w-48 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-accent-foreground/30"
        />
        <input
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value)
          }}
          placeholder="Display name"
          className="w-48 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-accent-foreground/30"
        />
        <select
          value={profileId}
          onChange={(e) => {
            setProfileId(e.target.value)
          }}
          className="rounded-md border bg-background px-2 py-1 text-sm"
          aria-label="Profile for the new agent"
        >
          <option value="">profile: chat default</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        A named agent is a full crew member: @mentionable in chat, with its own
        persistent memory folder in Files.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setOpen(false)
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={saving || !handle.trim() || !displayName.trim()}
        >
          Create agent
        </Button>
      </div>
    </form>
  )
}
