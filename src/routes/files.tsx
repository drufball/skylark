import { useCallback, useState } from 'react'
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'

import { deleteFile, listFiles, readFile, saveFile } from '@hull/files/server'
import { FILE_TOPIC_PATTERN } from '@hull/files/topic'
import { Dock } from '@rigging/views/dock'
import { FilesView } from '@rigging/views/files'
import { useShipLog } from '@rigging/lib/use-ship-log'

// The files route: a thin mount binding /files to the shared-documents view and
// the files service. `?path=` selects the open file (deep-linkable). Live
// updates ride the ship's log — every save anywhere emits on file:<path>, the
// route subscribes to the wildcard and re-runs its loader, so all tabs and crew
// see the same staged state.

interface FilesSearch {
  path?: string
}

export const Route = createFileRoute('/files')({
  component: FilesRoute,
  validateSearch: (search: Record<string, unknown>): FilesSearch => ({
    path: typeof search.path === 'string' ? search.path : undefined,
  }),
  loaderDeps: ({ search }) => ({ path: search.path }),
  loader: async ({ deps }) => {
    const files = await listFiles()
    const content = deps.path ? await readFile({ data: deps.path }) : null
    return { files, content }
  },
})

function FilesRoute() {
  const { files, content } = Route.useLoaderData()
  const { path: selected = null } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const onEvent = useCallback(() => {
    void router.invalidate()
  }, [router])
  useShipLog([FILE_TOPIC_PATTERN], onEvent)

  function open(path: string | null) {
    void navigate({ search: { path: path ?? undefined } })
  }

  async function save(path: string, body: string) {
    await saveFile({ data: { path, content: body } })
    await router.invalidate()
  }

  async function create(path: string) {
    setBusy(true)
    try {
      await saveFile({ data: { path, content: '' } })
      await router.invalidate()
      open(path)
    } finally {
      setBusy(false)
    }
  }

  async function remove(path: string) {
    setBusy(true)
    try {
      await deleteFile({ data: { path } })
      await router.invalidate()
      open(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dock active="files" Link={Link}>
      <FilesView
        files={files}
        selected={selected}
        content={content}
        busy={busy}
        onSelect={open}
        onSave={(path, body) => {
          void save(path, body)
        }}
        onCreate={(path) => {
          void create(path)
        }}
        onDelete={(path) => {
          void remove(path)
        }}
      />
    </Dock>
  )
}
