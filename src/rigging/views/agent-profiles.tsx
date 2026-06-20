import { useState } from 'react'
import { Bot, Plus, Save } from 'lucide-react'

import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'

// The profiles half of the Agents surface: list the profiles that tell the
// runtime *how* to boot an agent, and create/edit one. Presentational and
// routing-agnostic — it takes data + an onSave callback and knows nothing about
// fetching. A profile is the levers the pi.dev session is built from: which
// tools, whether to read CLAUDE.md / load skills, which extensions, the system
// prompt, an optional model override.

export interface ProfileSummary {
  id: string
  name: string
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

/** What `onSave` receives — the shape the server's `saveAgentProfile` takes. */
export interface ProfileFormValue {
  name: string
  systemPrompt: string | null
  tools: string[] | null
  readContextFiles: boolean
  useRepoSkills: boolean
  extensionIds: string[]
  model: string | null
}

/**
 * Parse the tools text field into an allowlist. Tools are entered comma- or
 * whitespace-separated; an empty field means "no allowlist" → null, which the
 * runtime reads as the default coding tools. Pure, so it's unit-tested directly.
 */
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

const BLANK: ProfileSummary = {
  id: '',
  name: '',
  systemPrompt: null,
  tools: null,
  readContextFiles: false,
  useRepoSkills: false,
  extensionIds: [],
  model: null,
}

export interface AgentProfilesProps {
  profiles: ProfileSummary[]
  extensions: ExtensionSummary[]
  /** A save is in flight — the form is disabled. */
  saving: boolean
  onSave: (value: ProfileFormValue) => void
}

export function AgentProfiles({
  profiles,
  extensions,
  saving,
  onSave,
}: AgentProfilesProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const selected = profiles.find((p) => p.id === editingId) ?? BLANK

  return (
    <main className="flex h-full bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex items-center gap-2 p-3">
          <Bot className="size-5 text-muted-foreground" />
          <span className="font-semibold">Profiles</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setEditingId(null)
            }}
            aria-label="New profile"
          >
            <Plus className="size-4" />
            New
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <nav className="flex flex-col gap-1 p-2">
            {profiles.length === 0 && (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                No profiles yet.
              </p>
            )}
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                onClick={() => {
                  setEditingId(profile.id)
                }}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md px-3 py-2 text-left text-sm',
                  'hover:bg-accent hover:text-accent-foreground',
                  profile.id === editingId &&
                    'bg-accent text-accent-foreground',
                )}
              >
                <span className="font-medium">{profile.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {profile.tools ? profile.tools.join(', ') : 'default tools'}
                </span>
              </button>
            ))}
          </nav>
        </ScrollArea>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        <ProfileForm
          key={selected.id || 'new'}
          profile={selected}
          extensions={extensions}
          saving={saving}
          onSave={onSave}
        />
      </section>
    </main>
  )
}

function ProfileForm({
  profile,
  extensions,
  saving,
  onSave,
}: {
  profile: ProfileSummary
  extensions: ExtensionSummary[]
  saving: boolean
  onSave: (value: ProfileFormValue) => void
}) {
  const [name, setName] = useState(profile.name)
  const [systemPrompt, setSystemPrompt] = useState(profile.systemPrompt ?? '')
  const [tools, setTools] = useState(formatToolList(profile.tools))
  const [readContextFiles, setReadContextFiles] = useState(
    profile.readContextFiles,
  )
  const [useRepoSkills, setUseRepoSkills] = useState(profile.useRepoSkills)
  const [extensionIds, setExtensionIds] = useState<string[]>(
    profile.extensionIds,
  )
  const [model, setModel] = useState(profile.model ?? '')

  // The form is remounted (via `key`) when the selected profile changes, so the
  // fields above seed once from props on mount and are then owned by the form.

  function toggleExtension(id: string) {
    setExtensionIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    )
  }

  function submit() {
    if (!name.trim() || saving) return
    // Send raw text; the server's normalizeProfileInput trims and folds blanks
    // to null (the one home for those rules). Tools are parsed here because the
    // field is a string the form owns.
    onSave({
      name,
      systemPrompt,
      tools: parseToolList(tools),
      readContextFiles,
      useRepoSkills,
      extensionIds,
      model,
    })
  }

  const inputClass =
    'w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 p-6">
      <h1 className="text-lg font-semibold">
        {profile.id ? `Edit ${profile.name}` : 'New profile'}
      </h1>

      <Field label="Name" hint="Unique. Saving an existing name edits it.">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
          }}
          placeholder="e.g. researcher"
        />
      </Field>

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
          hint="Discover the ship's skills (ship-feature, create-service, …)."
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

      <Field label="Model" hint="Override the default model. Blank = default.">
        <input
          className={inputClass}
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
          }}
          placeholder="claude-sonnet-4-5"
        />
      </Field>

      <div>
        <Button onClick={submit} disabled={saving || !name.trim()}>
          <Save className="size-4" />
          {saving ? 'Saving…' : 'Save profile'}
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
