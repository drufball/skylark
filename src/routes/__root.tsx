import {
  HeadContent,
  Scripts,
  createRootRoute,
  redirect,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import { currentSession } from '@hull/auth/server'
import appCss from '@rigging/styles.css?url'

// Any route reroutes to /login unless there's a valid session — this is UX
// only (an instant redirect instead of every door throwing "Not
// authenticated"); the real enforcement is currentActor() itself, which every
// web door already runs through. /login and /signup are the two doors into
// the ship, so they're exempt.
const PUBLIC_PATHS = new Set(['/login', '/signup'])

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return
    const me = await currentSession()
    if (!me) redirect({ to: '/login', throw: true })
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Skylark' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{ position: 'bottom-right' }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
