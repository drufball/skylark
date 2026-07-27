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
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLogInvalidate } from '@rigging/lib/use-ship-log-invalidate'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
import { useLogout } from '@rigging/lib/use-logout'

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
    // A hand-edited or stale ?path= must not take the route down — an invalid
    // path reads as "no such file", which the view renders as not-found.
    const content = deps.path
      ? await readFile({ data: deps.path }).catch(() => null)
      : null
    return { files, content }
  },
})

function FilesRoute() {
  const { files, content } = Route.useLoaderData()
  const { path: selected = null } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const { busy, run } = useServerAction()

  useShipLogInvalidate([FILE_TOPIC_PATTERN])

  function open(path: string | null) {
    void navigate({ search: { path: path ?? undefined } })
  }

  async function save(path: string, body: string) {
    await saveFile({ data: { path, content: body } })
    await router.invalidate()
  }

  async function create(path: string) {
    await run(async () => {
      await saveFile({ data: { path, content: '' } })
      open(path)
    })
  }

  async function remove(path: string) {
    await run(async () => {
      await deleteFile({ data: { path } })
      open(null)
    })
  }

  const onLogout = useLogout()
  const behindOrigin = useBehindOrigin()
  return (
    <Dock
      active="files"
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
    >
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
