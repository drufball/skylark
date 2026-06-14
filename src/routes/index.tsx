import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import {
  cancelAgentChat,
  getAgentChat,
  listAgentSessions,
  sendAgentMessage,
  startAgentChat,
} from '@hull/agent/server'
import { AgentChatView, type SessionSummary } from '@rigging/views/agent-chat'

// The ship's front door is the agent. This thin route does the data wiring the
// presentational view refuses to know about. Server data flows through the
// loader; because Postgres is the source of truth, re-running the loader on a
// timer is all "live updates" needs. The just-sent message is held optimistically
// until the turn persists it.
interface ChatSearch {
  session?: string
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    session: typeof search.session === 'string' ? search.session : undefined,
  }),
  loaderDeps: ({ search }) => ({ session: search.session }),
  loader: async ({ deps }) => {
    const sessions = await listAgentSessions()
    const chat = deps.session
      ? await getAgentChat({ data: deps.session })
      : null
    return { sessions, chat }
  },
  component: AgentRoute,
})

function AgentRoute() {
  const { session: activeId } = Route.useSearch()
  const { sessions, chat } = Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()

  const [busy, setBusy] = useState(false)
  // The just-sent message, shown optimistically until the durable transcript
  // (whose length we capture at send time) grows past it.
  const [pending, setPending] = useState<{
    text: string
    baseCount: number
  } | null>(null)

  useEffect(() => {
    const timer = setInterval(() => {
      void router.invalidate()
    }, 1500)
    return () => {
      clearInterval(timer)
    }
  }, [router])

  async function send(text: string) {
    setBusy(true)
    try {
      if (activeId) {
        setPending({ text, baseCount: chat?.items.length ?? 0 })
        await sendAgentMessage({ data: { sessionId: activeId, text } })
        await router.invalidate()
      } else {
        setPending({ text, baseCount: 0 })
        const { id } = await startAgentChat({ data: { text } })
        await navigate({ search: { session: id } })
      }
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    if (!activeId) return
    await cancelAgentChat({ data: activeId })
    await router.invalidate()
  }

  const items = chat?.items ?? []
  // Adjust state during render (React's blessed pattern): once the durable
  // transcript has caught up, drop the optimistic copy.
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

  return (
    <AgentChatView
      sessions={summaries}
      activeId={activeId}
      items={shown}
      running={chat?.session.status === 'running'}
      busy={busy}
      error={chat?.session.error ?? null}
      onSend={(text) => {
        void send(text)
      }}
      onCancel={() => {
        void cancel()
      }}
      onSelect={(id) => {
        void navigate({ search: { session: id } })
      }}
      onNew={() => {
        void navigate({ search: {} })
      }}
    />
  )
}
