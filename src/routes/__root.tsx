import {
  HeadContent,
  Scripts,
  createRootRoute,
  redirect,
} from '@tanstack/react-router'

import { currentSession } from '@hull/auth/server'
import appCss from '@rigging/styles.css?url'

// Any route reroutes to /login unless there's a valid session — this is UX
// only (an instant redirect instead of every door throwing "Not
// authenticated"). The real enforcement is per-door, not this redirect: a
// createServerFn is directly RPC-invocable, bypassing beforeLoad entirely, so
// each door is responsible for its own currentActor()/withCurrentActor() check
// — this only covers doors reached by page navigation. /login and /signup are
// the two doors into the ship, so they're exempt here.
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
        <Scripts />
      </body>
    </html>
  )
}
