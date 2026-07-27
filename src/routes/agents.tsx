import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'

import {
  cancelAgentChat,
  getAgentChat,
  getDefaultModel,
  listAgentExtensions,
  listAgentSessions,
  listGatewayModels,
  sendAgentMessage,
} from '@hull/agent/server'
import { agentMemoryIndexPath } from '@hull/agent/memory-paths'
import { sessionTopic } from '@hull/agent/topic'
import { listPlaybooksView, savePlaybook } from '@hull/issues/server'
import { createAgentUser, listCrew, updateAgentUser } from '@hull/users/server'
import { AgentChatView, type SessionSummary } from '@rigging/views/agent-chat'
import {
  AgentCrew,
  type AgentConfigValue,
  type CrewMemberSummary,
  type ExtensionSummary,
} from '@rigging/views/agent-crew'
import { Playbooks, type PlaybookFormValue } from '@rigging/views/playbooks'
import { Dock } from '@rigging/views/dock'
import { cn } from '@rigging/lib/utils'
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLogInvalidate } from '@rigging/lib/use-ship-log-invalidate'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
import { useLogout } from '@rigging/lib/use-logout'

// The Agents surface: the dedicated agent-management view. Three sub-tabs —
// the session **monitor** (the old front-door chat ux, which was only ever a
// way to watch sessions and unstick a wedged one with a direct message), the
// **crew** roster (named agents: create one, rename it, edit its boot config,
// open its memory), and **playbooks** (issue-handling strategies: which
// agents work an issue, and who starts). Live updates ride the ship's log,
// same as the front door.

type AgentTab = 'sessions' | 'crew' | 'playbooks'

interface AgentsSearch {
  tab: AgentTab
  session?: string
}

export const Route = createFileRoute('/agents')({
  validateSearch: (search: Record<string, unknown>): AgentsSearch => ({
    tab:
      search.tab === 'crew' || search.tab === 'playbooks'
        ? search.tab
        : 'sessions',
    session: typeof search.session === 'string' ? search.session : undefined,
  }),
  loaderDeps: ({ search }) => ({ session: search.session }),
  loader: async ({ deps }) => {
    const [sessions, extensions, gateway, def, crew, playbooks] =
      await Promise.all([
        listAgentSessions(),
        listAgentExtensions(),
        listGatewayModels(),
        getDefaultModel(),
        listCrew(),
        listPlaybooksView(),
      ])
    // The default first, then whatever else the gateway serves.
    const modelOptions = [
      def.ref,
      ...gateway.models.filter((m) => m !== def.ref),
    ]
    const chat = deps.session
      ? await getAgentChat({ data: deps.session })
      : null
    return {
      sessions,
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
  const { sessions, extensions, modelOptions, chat, crew, playbooks } =
    Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()

  const { busy, run } = useServerAction()
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<{
    text: string
    baseCount: number
  } | null>(null)

  const running = chat?.session.status === 'running'

  // Watch the active session over the ship's log; re-run the loader on any
  // event. No active session → empty topics → no connection.
  const topics = activeId ? [sessionTopic(activeId)] : []
  useShipLogInvalidate(topics)

  async function send(text: string) {
    if (!activeId) return // the monitor doesn't start sessions, only unsticks
    setPending({ text, baseCount: chat?.items.length ?? 0 })
    await run(() => sendAgentMessage({ data: { sessionId: activeId, text } }))
  }

  async function cancel() {
    if (!activeId) return
    await cancelAgentChat({ data: activeId })
    await router.invalidate()
  }

  async function createCrewAgent(input: {
    handle: string
    displayName: string
  }) {
    setSaving(true)
    try {
      await createAgentUser({ data: input })
      await router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  async function updateCrew(input: { userId: string; displayName?: string }) {
    setSaving(true)
    try {
      await updateAgentUser({ data: input })
      await router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  async function updateCrewConfig(
    input: { userId: string } & AgentConfigValue,
  ) {
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
    systemPrompt: m.systemPrompt,
    tools: m.tools,
    readContextFiles: m.readContextFiles,
    useRepoSkills: m.useRepoSkills,
    extensionIds: m.extensionIds,
    model: m.model,
  }))

  const onLogout = useLogout()
  const behindOrigin = useBehindOrigin()
  return (
    <Dock
      active="agents"
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
    >
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
              extensions={extensionSummaries}
              modelOptions={modelOptions}
              saving={saving}
              onCreate={(input) => {
                void createCrewAgent(input)
              }}
              onUpdate={(input) => {
                void updateCrew(input)
              }}
              onUpdateConfig={(input) => {
                void updateCrewConfig(input)
              }}
              onOpenMemory={(handle) => {
                void navigate({
                  to: '/files',
                  search: { path: agentMemoryIndexPath(handle) },
                })
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
      {(['sessions', 'crew', 'playbooks'] as const).map((t) => (
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
