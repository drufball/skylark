import { useCallback, useState } from 'react'
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'

import { markInboxRead, myInbox } from '@hull/notifications/server'
import { notifyTopic } from '@hull/notifications/topic'
import { Dock } from '@rigging/views/dock'
import { InboxView } from '@rigging/views/inbox'
import { useShipLog } from '@rigging/lib/use-ship-log'

// The inbox route: a thin mount binding /inbox to the notifications service.
// Live updates ride the ship's log — every notification is announced on the
// owner's private notify:<userId> topic, the route subscribes to its own and
// re-runs the loader, so the bell rings the moment something lands.

export const Route = createFileRoute('/inbox')({
  component: InboxRoute,
  loader: () => myInbox(),
})

function InboxRoute() {
  const { me, items, unread } = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const onEvent = useCallback(() => {
    void router.invalidate()
  }, [router])
  useShipLog([notifyTopic(me.id)], onEvent)

  async function markAllRead() {
    setBusy(true)
    try {
      await markInboxRead()
      await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dock active="inbox" Link={Link}>
      <InboxView
        entries={items}
        unread={unread}
        busy={busy}
        onMarkAllRead={() => {
          void markAllRead()
        }}
        onOpenIssue={(issueId) => {
          void navigate({ to: '/issues/$id', params: { id: issueId } })
        }}
      />
    </Dock>
  )
}
