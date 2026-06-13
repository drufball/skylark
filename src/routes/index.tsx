import { createFileRoute } from '@tanstack/react-router'

import { getShipHealth } from '@hull/health/server'
import { ShipStatus } from '@rigging/views/ship-status'

// A thin mount: this route binds a URL to a view (from rigging) and the data it
// needs (a service from hull). The view itself knows nothing about routing, and
// could just as easily come from home.
export const Route = createFileRoute('/')({
  component: IndexRoute,
  loader: () => getShipHealth(),
})

function IndexRoute() {
  return <ShipStatus health={Route.useLoaderData()} />
}
