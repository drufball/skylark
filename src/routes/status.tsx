import { createFileRoute } from '@tanstack/react-router'

import { getShipHealth } from '@hull/health/server'
import { ShipStatus } from '@rigging/views/ship-status'

// A thin mount: binds /status to the ship-status view and the health data it
// needs. The agent chat is the ship's front door (/), so the pulse moved here.
export const Route = createFileRoute('/status')({
  component: StatusRoute,
  loader: () => getShipHealth(),
})

function StatusRoute() {
  return <ShipStatus health={Route.useLoaderData()} />
}
