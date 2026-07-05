import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { login } from '@hull/auth/server'
import { AuthForm } from '@rigging/views/auth-form'
import { useServerAction } from '@rigging/lib/use-server-action'
import { errorMessage } from '@hull/lib/errors'

export const Route = createFileRoute('/login')({
  component: LoginRoute,
})

function LoginRoute() {
  const navigate = useNavigate()
  const { busy, run } = useServerAction()
  const [error, setError] = useState<string | null>(null)

  async function submit(input: { handle: string; password: string }) {
    setError(null)
    try {
      await run(() => login({ data: input }))
      await navigate({ to: '/' })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <AuthForm
      mode="login"
      busy={busy}
      error={error}
      onSubmit={(input) => {
        void submit(input)
      }}
      Link={Link}
    />
  )
}
