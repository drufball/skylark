import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useState } from 'react'

import {
  cancelAgentChat,
  getAgentChat,
  getDefaultModel,
  listAgentExtensions,
  listAgentProfiles,
  listAgentSessions,
  saveAgentProfile,
  sendAgentMessage,
} from '@hull/agent/server'
import { agentMemoryIndexPath } from '@hull/agent/memory-paths'
import { listLocalModels } from '@hull/local-model/server'
import { modelPickerOptions } from '@hull/local-model/ollama-client'
import { listPlaybooksView, savePlaybook } from '@hull/issues/server'
import { createAgentUser, listCrew, updateAgentUser } from '@hull/users/server'
import { AgentChatView, type SessionSummary } from '@rigging/views/agent-chat'
import { AgentCrew, type CrewMemberSummary } from '@rigging/views/agent-crew'
import { Playbooks, type PlaybookFormValue } from '@rigging/views/playbooks'
import {
  AgentProfiles,
  type ExtensionSummary,
  type ProfileFormValue,
  type ProfileSummary,
} from '@rigging/views/agent-profiles'
import { Dock } from '@rigging/views/dock'
import { cn } from '@rigging/lib/utils'
import { useShipLog } from '@rigging/lib/use-ship-log'

// The Agents surface: the dedicated agent-management view. Four sub-tabs —
// the session **monitor** (the old front-door chat ux, which was only ever a
// way to watch sessions and unstick a wedged one with a direct message), the
// **profiles** editor (the data that tells the runtime how to boot an agent),
// the **crew** roster (named agents: create one, rename it, point it at a
// profile, open its memory), and **playbooks** (issue-handling strategies:
// which agents work an issue, and who starts). Live updates ride the ship's
// log, same as the front door.

type AgentTab = 'sessions' | 'profiles' | 'crew' | 'playbooks'

interface AgentsSearch {
  tab: AgentTab
  session?: string
}

export const Route = createFileRoute('/agents')({
  validateSearch: (search: Record<string, unknown>): AgentsSearch => ({
    tab:
      search.tab === 'profiles' ||
      search.tab === 'crew' ||
      search.tab === 'playbooks'
        ? search.tab
        : 'sessions',
    session: typeof search.session === 'string' ? search.session : undefined,
  }),
  loaderDeps: ({ search }) => ({ session: search.session }),
  loader: async ({ deps }) => {
    const [sessions, profiles, extensions, local, def, crew, playbooks] =
      await Promise.all([
        listAgentSessions(),
        listAgentProfiles(),
        listAgentExtensions(),
        listLocalModels(),
        getDefaultModel(),
        listCrew(),
        listPlaybooksView(),
      ])
    const modelOptions = modelPickerOptions(def.ref, local.installed)
    const chat = deps.session
      ? await getAgentChat({ data: deps.session })
      : null
    return {
      sessions,
      profiles,
      extensions,
      modelOptions,
      chat,
      crew,
      playbooks,
    }
  },
  component: AgentsRoute,
})

function AgentsRoute() {
  const { tab, session: activeId } = Route.useSearch()
  const {
    sessions,
    profiles,
    extensions,
    modelOptions,
    chat,
    crew,
    playbooks,
  } = Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()

  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<{
    text: string
    baseCount: number
  } | null>(null)

  const running = chat?.session.status === 'running'

  // Watch the active session over the ship's log; re-run the loader on any
  // event. No active session → empty topics → no connection.
  const topics = activeId ? [`session:${activeId}`] : []
  const onShipLogEvent = useCallback(() => {
    void router.invalidate()
  }, [router])
  useShipLog(topics, onShipLogEvent)

  async function send(text: string) {
    if (!activeId) return // the monitor doesn't start sessions, only unsticks
    setBusy(true)
    try {
      setPending({ text, baseCount: chat?.items.length ?? 0 })
      await sendAgentMessage({ data: { sessionId: activeId, text } })
      await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    if (!activeId) return
    await cancelAgentChat({ data: activeId })
    await router.invalidate()
  }

  async function saveProfile(value: ProfileFormValue) {
    setSaving(true)
    try {
      await saveAgentProfile({ data: value })
      await router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  async function createCrewAgent(input: {
    handle: string
    displayName: string
    profileId: string | null
  }) {
    setSaving(true)
    try {
      await createAgentUser({ data: input })
      await router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  async function updateCrew(input: {
    userId: string
    displayName?: string
    profileId?: string
  }) {
    setSaving(true)
    try {
      await updateAgentUser({ data: input })
      await router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  async function savePlaybookValue(value: PlaybookFormValue) {
    setSaving(true)
    try {
      await savePlaybook({ data: value })
      await router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  const items = chat?.items ?? []
  if (pending && items.length > pending.baseCount) setPending(null)
  const shown =
    pending && items.length <= pending.baseCount
      ? [...items, { kind: 'user' as const, text: pending.text }]
      : items

  const summaries: SessionSummary[] = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
  }))
  const profileSummaries: ProfileSummary[] = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    systemPrompt: p.systemPrompt,
    tools: p.tools,
    readContextFiles: p.readContextFiles,
    useRepoSkills: p.useRepoSkills,
    extensionIds: p.extensionIds,
    model: p.model,
  }))
  const extensionSummaries: ExtensionSummary[] = extensions.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
  }))
  const crewSummaries: CrewMemberSummary[] = crew.map((m) => ({
    id: m.id,
    handle: m.handle,
    displayName: m.displayName,
    type: m.type,
    profileId: m.profileId,
  }))

  return (
    <Dock active="agents" Link={Link}>
      <div className="flex h-full flex-col">
        <TabBar
          tab={tab}
          onTab={(next) => {
            void navigate({ search: (prev) => ({ ...prev, tab: next }) })
          }}
        />
        <div className="min-h-0 flex-1">
          {tab === 'playbooks' ? (
            <Playbooks
              playbooks={playbooks}
              agents={crewSummaries
                .filter((m) => m.type === 'agent')
                .map((m) => ({ id: m.id, handle: m.handle }))}
              saving={saving}
              onSave={(value) => {
                void savePlaybookValue(value)
              }}
            />
          ) : tab === 'crew' ? (
            <AgentCrew
              crew={crewSummaries}
              profiles={profiles.map((p) => ({ id: p.id, name: p.name }))}
              saving={saving}
              onCreate={(input) => {
                void createCrewAgent(input)
              }}
              onUpdate={(input) => {
                void updateCrew(input)
              }}
              onOpenMemory={(handle) => {
                void navigate({
                  to: '/files',
                  search: { path: agentMemoryIndexPath(handle) },
                })
              }}
            />
          ) : tab === 'profiles' ? (
            <AgentProfiles
              profiles={profileSummaries}
              extensions={extensionSummaries}
              modelOptions={modelOptions}
              saving={saving}
              onSave={(value) => {
                void saveProfile(value)
              }}
            />
          ) : (
            <AgentChatView
              sessions={summaries}
              activeId={activeId}
              items={shown}
              running={running}
              busy={busy}
              error={chat?.session.error ?? null}
              emptyTitle="Session monitor"
              emptyHint="Pick a session to watch its transcript — and send a direct message to unstick a wedged one."
              onSend={(text) => {
                void send(text)
              }}
              onCancel={() => {
                void cancel()
              }}
              onSelect={(id) => {
                void navigate({ search: (prev) => ({ ...prev, session: id }) })
              }}
            />
          )}
        </div>
      </div>
    </Dock>
  )
}

function TabBar({
  tab,
  onTab,
}: {
  tab: AgentTab
  onTab: (t: AgentTab) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b bg-muted/20 px-3 py-2">
      {(['sessions', 'profiles', 'crew', 'playbooks'] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => {
            onTab(t)
          }}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium capitalize',
            'hover:bg-accent hover:text-accent-foreground',
            t === tab
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground',
          )}
          aria-current={t === tab ? 'page' : undefined}
        >
          {t}
        </button>
      ))}
    </div>
  )
}
