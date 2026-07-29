import { createFileRoute, Link, useRouter } from '@tanstack/react-router'

import {
  getDefaultModel,
  listGatewayModels,
  setDefaultModel,
} from '@hull/agent/server'
import { Dock } from '@rigging/views/dock'
import { Models } from '@rigging/views/models'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
import { useLogout } from '@rigging/lib/use-logout'
import { useUnreadCount } from '@rigging/lib/use-unread-count'

// Thin mount: binds /models to the Models view and the data it needs.

export const Route = createFileRoute('/models')({
  loader: async () => {
    const [gateway, def] = await Promise.all([
      listGatewayModels(),
      getDefaultModel(),
    ])
    return { gateway, defaultRef: def.ref }
  },
  component: ModelsRoute,
})

function ModelsRoute() {
  const { gateway, defaultRef } = Route.useLoaderData()
  const onLogout = useLogout()
  const behindOrigin = useBehindOrigin()
  const unreadCount = useUnreadCount()
  const router = useRouter()

  async function onSetDefault(model: string) {
    await setDefaultModel({ data: { model } })
    await router.invalidate()
  }

  return (
    <Dock
      active="models"
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
      unreadCount={unreadCount}
    >
      <Models
        defaultRef={defaultRef}
        gateway={gateway}
        onSetDefault={(model) => void onSetDefault(model)}
      />
    </Dock>
  )
}
