import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { signup } from '@hull/auth/server'
import { welcomeAboard } from '@rigging/rooms/server'
import { AuthForm } from '@rigging/views/auth-form'
import { useServerAction } from '@rigging/lib/use-server-action'
import { errorMessage } from '@hull/lib/errors'

export const Route = createFileRoute('/signup')({
  component: SignupRoute,
})

function SignupRoute() {
  const navigate = useNavigate()
  const { busy, run } = useServerAction()
  const [error, setError] = useState<string | null>(null)

  async function submit(input: {
    handle: string
    password: string
    inviteCode: string
  }) {
    setError(null)
    try {
      await run(() => signup({ data: input }))
      // Bring them into the ship's default rooms and put those rooms on their
      // home screen, so `/` is a working ship rather than a blank grid. The
      // boot seed does this for the crew already aboard; somebody signing up
      // between restarts would otherwise wait for one. Best-effort on purpose:
      // an account that exists must not be blocked by its own welcome, and the
      // next boot converges anybody this missed.
      await welcomeAboard().catch(() => undefined)
      await navigate({ to: '/' })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <AuthForm
      mode="signup"
      busy={busy}
      error={error}
      onSubmit={(input) => {
        void submit(input)
      }}
      Link={Link}
    />
  )
}
