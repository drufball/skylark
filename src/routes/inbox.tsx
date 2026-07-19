import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'

import { markInboxRead, myInbox } from '@hull/notifications/server'
import { notifyTopic } from '@hull/notifications/topic'
import { Dock } from '@rigging/views/dock'
import { InboxView } from '@rigging/views/inbox'
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLogInvalidate } from '@rigging/lib/use-ship-log-invalidate'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
import { useLogout } from '@rigging/lib/use-logout'

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
  const { busy, run } = useServerAction()

  useShipLogInvalidate([notifyTopic(me.id)])

  async function markAllRead() {
    await run(() => markInboxRead())
  }

  const onLogout = useLogout()
  const behindOrigin = useBehindOrigin()
  return (
    <Dock
      active="inbox"
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
    >
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
