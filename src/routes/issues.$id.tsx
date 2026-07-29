import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'

import { commentOnIssue, getThread, setIssueStatus } from '@hull/issues/server'
import { issueTopic } from '@hull/issues/topic'
import { setWatch, watchState } from '@hull/notifications/server'
import { Dock } from '@rigging/views/dock'
import { IssueThreadView } from '@rigging/views/issue-thread'
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLogInvalidate } from '@rigging/lib/use-ship-log-invalidate'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
import { useLogout } from '@rigging/lib/use-logout'
import { useUnreadCount } from '@rigging/lib/use-unread-count'

// The thread route: a thin mount binding /issues/$id to the thread view. Live
// updates subscribe to the issue's own topic, so comments, status changes, and
// the builder's progress line stream in without a refresh.
export const Route = createFileRoute('/issues/$id')({
  component: ThreadRoute,
  loader: async ({ params }) => {
    const [thread, watch] = await Promise.all([
      getThread({ data: params.id }),
      watchState({ data: issueTopic(params.id) }),
    ])
    return { thread, watching: watch.watching }
  },
})

function ThreadRoute() {
  const { thread, watching } = Route.useLoaderData()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { busy, run } = useServerAction()

  useShipLogInvalidate([issueTopic(id)])

  async function comment(body: string) {
    await run(() => commentOnIssue({ data: { issueId: id, body } }))
  }

  async function setStatus(status: string) {
    await run(() => setIssueStatus({ data: { issueId: id, status } }))
  }

  async function toggleWatch() {
    await run(() =>
      setWatch({ data: { topic: issueTopic(id), watching: !watching } }),
    )
  }

  const onLogout = useLogout()
  const behindOrigin = useBehindOrigin()
  const unreadCount = useUnreadCount()

  if (!thread) {
    return (
      <Dock
        Link={Link}
        onLogout={onLogout}
        behindOrigin={behindOrigin}
        unreadCount={unreadCount}
      >
        <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
          <div>
            <p>That issue doesn&apos;t exist.</p>
            <Link to="/issues" className="underline">
              Back to the board
            </Link>
          </div>
        </div>
      </Dock>
    )
  }

  return (
    <Dock
      // No `active`: this view left the rail for its ROOM, which is what links
      // here now — see rigging/views/dock.tsx.
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
      unreadCount={unreadCount}
    >
      <IssueThreadView
        thread={thread}
        busy={busy}
        watching={watching}
        onBack={() => {
          void navigate({ to: '/issues' })
        }}
        onComment={(body) => {
          void comment(body)
        }}
        onSetStatus={(status) => {
          void setStatus(status)
        }}
        onToggleWatch={() => {
          void toggleWatch()
        }}
      />
    </Dock>
  )
}
