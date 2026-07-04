import { createFileRoute, Link } from '@tanstack/react-router'

import { getDefaultModel, listGatewayModels } from '@hull/agent/server'
import { Dock } from '@rigging/views/dock'
import { Models } from '@rigging/views/models'

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
  return (
    <Dock active="models" Link={Link}>
      <Models defaultRef={defaultRef} gateway={gateway} />
    </Dock>
  )
}
