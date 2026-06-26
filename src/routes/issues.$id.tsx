import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useState } from 'react'

import { commentOnIssue, getThread, setIssueStatus } from '@hull/issues/server'
import { issueTopic } from '@hull/issues/topic'
import { Dock } from '@rigging/views/dock'
import { IssueThreadView } from '@rigging/views/issue-thread'
import { useShipLog } from '@rigging/lib/use-ship-log'

// The thread route: a thin mount binding /issues/$id to the thread view. Live
// updates subscribe to the issue's own topic, so comments, status changes, and
// the builder's progress line stream in without a refresh.
export const Route = createFileRoute('/issues/$id')({
  component: ThreadRoute,
  loader: ({ params }) => getThread({ data: params.id }),
})

function ThreadRoute() {
  const thread = Route.useLoaderData()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const onEvent = useCallback(() => {
    void router.invalidate()
  }, [router])
  useShipLog([issueTopic(id)], onEvent)

  async function comment(body: string) {
    setBusy(true)
    try {
      await commentOnIssue({ data: { issueId: id, body } })
      await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  async function setStatus(status: string) {
    setBusy(true)
    try {
      await setIssueStatus({ data: { issueId: id, status } })
      await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  if (!thread) {
    return (
      <Dock active="issues" Link={Link}>
        <div className="flex h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
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
    <Dock active="issues" Link={Link}>
      <IssueThreadView
        thread={thread}
        busy={busy}
        onBack={() => {
          void navigate({ to: '/issues' })
        }}
        onComment={(body) => {
          void comment(body)
        }}
        onSetStatus={(status) => {
          void setStatus(status)
        }}
      />
    </Dock>
  )
}
