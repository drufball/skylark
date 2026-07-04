import { useState } from 'react'
import { BookOpen, Bot, Plus, User } from 'lucide-react'

import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'
import { inputClass as sharedInputClass } from '@rigging/components/ui/input'

// The Crew tab: the ship's roster, and where named agents are made and
// configured. A named agent is a full crew member — a users row — carrying
// its own boot config (system prompt, tools, whether it reads CLAUDE.md /
// loads repo skills, which extensions, an optional model) directly, plus a
// persistent memory folder in the shared files (what it knows). There's no
// separate profile to point at: each agent's card IS its config editor.
// Presentational and routing-agnostic: the route wires the doors and the
// address bar.

/** Parse the tools text field into an allowlist. Comma- or whitespace-
 * separated; an empty field means "no allowlist" → null, which the runtime
 * reads as the default coding tools. Pure, so it's unit-tested directly. */
export function parseToolList(input: string): string[] | null {
  const tools = input
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  return tools.length > 0 ? tools : null
}

/** Render a tool allowlist back into the editable text field. */
export function formatToolList(tools: string[] | null): string {
  return tools ? tools.join(', ') : ''
}

export interface CrewMemberSummary {
  id: string
  handle: string
  displayName: string
  type: 'human' | 'agent'
  /** System prompt for the agent. Null = pi.dev's default. Irrelevant for humans. */
  systemPrompt: string | null
  /** Tool allowlist; null = the default coding tools. */
  tools: string[] | null
  readContextFiles: boolean
  useRepoSkills: boolean
  extensionIds: string[]
  model: string | null
}

export interface ExtensionSummary {
  id: string
  name: string
  description: string
}

/** What a config save sends — every field together, the shape `updateAgentUser` takes. */
export interface AgentConfigValue {
  systemPrompt: string | null
  tools: string[] | null
  readContextFiles: boolean
  useRepoSkills: boolean
  extensionIds: string[]
  model: string | null
}

export interface AgentCrewProps {
  crew: CrewMemberSummary[]
  extensions: ExtensionSummary[]
  /** Suggested model refs for the picker (installed local + the default). */
  modelOptions: string[]
  saving: boolean
  onCreate: (input: { handle: string; displayName: string }) => void
  onUpdate: (input: { userId: string; displayName?: string }) => void
  onUpdateConfig: (input: { userId: string } & AgentConfigValue) => void
  /** Open an agent's memory index in the Files surface. */
  onOpenMemory: (handle: string) => void
}

export function AgentCrew({
  crew,
  extensions,
  modelOptions,
  saving,
  onCreate,
  onUpdate,
  onUpdateConfig,
  onOpenMemory,
}: AgentCrewProps) {
  const agents = crew.filter((m) => m.type === 'agent')
  const humans = crew.filter((m) => m.type === 'human')

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl p-6">
        <NewAgent saving={saving} onCreate={onCreate} />

        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Agents · {agents.length}
          </h2>
          <div className="flex flex-col gap-2">
            {agents.map((member) => (
              <AgentCard
                key={member.id}
                member={member}
                extensions={extensions}
                modelOptions={modelOptions}
                saving={saving}
                onUpdate={onUpdate}
                onUpdateConfig={onUpdateConfig}
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
  extensions,
  modelOptions,
  saving,
  onUpdate,
  onUpdateConfig,
  onOpenMemory,
}: {
  member: CrewMemberSummary
  extensions: ExtensionSummary[]
  modelOptions: string[]
  saving: boolean
  onUpdate: AgentCrewProps['onUpdate']
  onUpdateConfig: AgentCrewProps['onUpdateConfig']
  onOpenMemory: (handle: string) => void
}) {
  const [name, setName] = useState(member.displayName)
  const [expanded, setExpanded] = useState(false)

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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setExpanded((v) => !v)
          }}
        >
          {expanded ? 'Hide config' : 'Edit config'}
        </Button>
      </div>
      {expanded && (
        <AgentConfigForm
          member={member}
          extensions={extensions}
          modelOptions={modelOptions}
          saving={saving}
          onSave={(config) => {
            onUpdateConfig({ userId: member.id, ...config })
          }}
        />
      )}
    </div>
  )
}

function AgentConfigForm({
  member,
  extensions,
  modelOptions,
  saving,
  onSave,
}: {
  member: CrewMemberSummary
  extensions: ExtensionSummary[]
  modelOptions: string[]
  saving: boolean
  onSave: (value: AgentConfigValue) => void
}) {
  const [systemPrompt, setSystemPrompt] = useState(member.systemPrompt ?? '')
  const [tools, setTools] = useState(formatToolList(member.tools))
  const [readContextFiles, setReadContextFiles] = useState(
    member.readContextFiles,
  )
  const [useRepoSkills, setUseRepoSkills] = useState(member.useRepoSkills)
  const [extensionIds, setExtensionIds] = useState<string[]>(
    member.extensionIds,
  )
  const [model, setModel] = useState(member.model ?? '')

  function toggleExtension(id: string) {
    setExtensionIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    )
  }

  function submit() {
    if (saving) return
    // Send raw text; parseToolList/the server's normalization fold blanks to
    // null (the one home for those rules).
    onSave({
      systemPrompt,
      tools: parseToolList(tools),
      readContextFiles,
      useRepoSkills,
      extensionIds,
      model,
    })
  }

  const inputClass = sharedInputClass()
  const datalistId = `model-options-${member.id}`

  return (
    <div className="flex flex-col gap-4 border-t pt-3 pl-6">
      <Field
        label="System prompt"
        hint="What this agent is for. Blank uses the runtime default."
      >
        <Textarea
          value={systemPrompt}
          onChange={(e) => {
            setSystemPrompt(e.target.value)
          }}
          rows={4}
          placeholder="You pilot a Skylark ship…"
        />
      </Field>

      <Field
        label="Tools"
        hint="Allowlist, comma-separated (e.g. read, bash). Blank = the default coding tools (read, bash, edit, write)."
      >
        <input
          className={inputClass}
          value={tools}
          onChange={(e) => {
            setTools(e.target.value)
          }}
          placeholder="read, bash"
        />
      </Field>

      <div className="flex flex-col gap-2">
        <Check
          checked={readContextFiles}
          onChange={setReadContextFiles}
          label="Read CLAUDE.md"
          hint="Feed the ship's context file to the agent."
        />
        <Check
          checked={useRepoSkills}
          onChange={setUseRepoSkills}
          label="Load repo skills"
          hint="Discover the ship's skills (build-feature, create-service, …)."
        />
      </div>

      <Field
        label="Extensions"
        hint="pi.dev extensions to load for this agent."
      >
        {extensions.length === 0 ? (
          <p className="text-sm text-muted-foreground">None registered yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {extensions.map((ext) => (
              <Check
                key={ext.id}
                checked={extensionIds.includes(ext.id)}
                onChange={() => {
                  toggleExtension(ext.id)
                }}
                label={ext.name}
                hint={ext.description}
              />
            ))}
          </div>
        )}
      </Field>

      <Field
        label="Model"
        hint="Which model runs this agent. Blank = the ship default. Pick an installed local model or type any ref, e.g. anthropic/claude-sonnet-4-5."
      >
        <input
          className={inputClass}
          value={model}
          list={datalistId}
          onChange={(e) => {
            setModel(e.target.value)
          }}
          placeholder="ollama/qwen3-coder:30b"
        />
        <datalist id={datalistId}>
          {modelOptions.map((ref) => (
            <option key={ref} value={ref} />
          ))}
        </datalist>
      </Field>

      <div>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save config'}
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {children}
    </label>
  )
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
      />
      <span className="flex flex-col">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

function NewAgent({
  saving,
  onCreate,
}: Pick<AgentCrewProps, 'saving' | 'onCreate'>) {
  const [open, setOpen] = useState(false)
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')

  function submit() {
    const h = handle.trim().toLowerCase()
    const n = displayName.trim()
    if (!h || !n || saving) return
    onCreate({ handle: h, displayName: n })
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
      </div>
      <p className="text-xs text-muted-foreground">
        A named agent is a full crew member: @mentionable in chat, with its own
        persistent memory folder in Files. It starts as a read-only chat pilot —
        edit its config below to give it more.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            // A cancelled draft is discarded — reopening starts blank.
            setHandle('')
            setDisplayName('')
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
