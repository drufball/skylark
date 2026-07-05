import type { ComponentType, ReactNode } from 'react'
import { useState } from 'react'
import { Anchor } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@rigging/components/ui/card'
import { Button } from '@rigging/components/ui/button'
import { Input } from '@rigging/components/ui/input'

// The pre-auth surfaces: log in or create an account. Standalone (no Dock —
// there's nothing to switch to until you're aboard). Login and signup share
// this one form since they differ only by a field and a submit label.

export type AuthLink = ComponentType<{
  to: string
  className?: string
  children: ReactNode
}>

export interface AuthFormProps {
  mode: 'login' | 'signup'
  busy: boolean
  error: string | null
  onSubmit: (input: {
    handle: string
    password: string
    inviteCode: string
  }) => void
  /** The router's Link (or a stand-in in tests), to cross-link the other form. */
  Link: AuthLink
}

export function AuthForm({ mode, busy, error, onSubmit, Link }: AuthFormProps) {
  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')

  return (
    <div className="flex h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-1 flex items-center gap-2">
            <Anchor className="size-5 text-muted-foreground" />
            <CardTitle>Skylark</CardTitle>
          </div>
          <CardDescription>
            {mode === 'login'
              ? 'Log in to your ship.'
              : 'Create an account — you need an invite code from the operator.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit({ handle, password, inviteCode })
            }}
          >
            <Input
              aria-label="Handle"
              placeholder="handle"
              autoComplete="username"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value)
              }}
            />
            <Input
              aria-label="Password"
              type="password"
              placeholder="password"
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
              }}
            />
            {mode === 'signup' && (
              <Input
                aria-label="Invite code"
                placeholder="invite code"
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value)
                }}
              />
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>
              {mode === 'login' ? 'Log in' : 'Create account'}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {mode === 'login' ? (
              <>
                Need an account? <Link to="/signup">Sign up</Link>
              </>
            ) : (
              <>
                Already aboard? <Link to="/login">Log in</Link>
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
