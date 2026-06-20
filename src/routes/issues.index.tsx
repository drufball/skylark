import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useState } from 'react'

import { listBoard, openIssue } from '@hull/issues/server'
import { Dock } from '@rigging/views/dock'
import { IssueBoardView } from '@rigging/views/issue-board'
import { useShipLog } from '@rigging/lib/use-ship-log'

// The board route: a thin mount binding /issues to the board view and the issues
// service. Live updates ride the ship's log — the board subscribes to the public
// scope (where every issue.* event is mirrored) and re-runs the loader when one
// lands, so a status change or a new comment anywhere updates the board live.
export const Route = createFileRoute('/issues/')({
  component: BoardRoute,
  loader: () => listBoard(),
})

function BoardRoute() {
  const issues = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const onEvent = useCallback(() => {
    void router.invalidate()
  }, [router])
  // Subscribe to all issue events via pattern matching
  useShipLog(['issue:*'], onEvent)

  async function open(title: string, body: string) {
    setBusy(true)
    try {
      const { id } = await openIssue({ data: { title, body } })
      await navigate({ to: '/issues/$id', params: { id } })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dock active="issues" Link={Link}>
      <IssueBoardView
        issues={issues}
        busy={busy}
        onOpen={(title, body) => {
          void open(title, body)
        }}
        onSelect={(id) => {
          void navigate({ to: '/issues/$id', params: { id } })
        }}
      />
    </Dock>
  )
}
