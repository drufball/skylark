import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'

import { listBoard, listPlaybooksView, openIssue } from '@hull/issues/server'
import { ISSUE_TOPIC_PATTERN } from '@hull/issues/topic'
import { Dock } from '@rigging/views/dock'
import { IssueBoardView } from '@rigging/views/issue-board'
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLogInvalidate } from '@rigging/lib/use-ship-log-invalidate'

// The board route: a thin mount binding /issues to the board view and the issues
// service. Live updates ride the ship's log — the board subscribes to the
// issue:* topic pattern (every issue.* event rides it) and re-runs the loader
// when one lands, so a status change or a new comment anywhere updates the board
// live.
export const Route = createFileRoute('/issues/')({
  component: BoardRoute,
  loader: async () => {
    const [issues, playbooks] = await Promise.all([
      listBoard(),
      listPlaybooksView(),
    ])
    return { issues, playbooks }
  },
})

function BoardRoute() {
  const { issues, playbooks } = Route.useLoaderData()
  const navigate = useNavigate()
  const { busy, run } = useServerAction()

  useShipLogInvalidate([ISSUE_TOPIC_PATTERN])

  async function open(title: string, body: string, playbookId?: string) {
    const result = await run(() =>
      openIssue({ data: { title, body, playbookId } }),
    )
    if (result) {
      await navigate({ to: '/issues/$id', params: { id: result.id } })
    }
  }

  return (
    <Dock active="issues" Link={Link}>
      <IssueBoardView
        issues={issues}
        playbooks={playbooks.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          isDefault: p.isDefault,
        }))}
        busy={busy}
        onOpen={(title, body, playbookId) => {
          void open(title, body, playbookId)
        }}
        onSelect={(id) => {
          void navigate({ to: '/issues/$id', params: { id } })
        }}
      />
    </Dock>
  )
}
