import { createServerFn } from '@tanstack/react-start'
import {
  deleteCookie,
  getCookie,
  getRequestProtocol,
  setCookie,
} from '@tanstack/react-start/server'

import { systemDb } from '@hull/db/client'
import { getCurrentUser } from '@hull/users/actor'
import type { UserRow } from '@hull/users/schema'

import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  signup as signupUser,
  verifyLogin,
} from './service'

// The web doors onto login/signup/logout — the only doors in the app that run
// BEFORE an actor exists, so they touch `systemDb` directly (see
// eslint.config.js's allowlist) rather than `db` + `withCurrentActor`.

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** Hand the browser its session cookie. `secure` follows the request's actual
 * protocol (honors `x-forwarded-proto`), so it's on once this sits behind a
 * TLS-terminating tunnel and off for plain-http local dev — no env flag to
 * misconfigure. */
function setSessionCookie(token: string): void {
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: getRequestProtocol() === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

/** Who's logged in, or null — the non-throwing check the root route's
 * `beforeLoad` uses to decide whether to redirect to `/login`. */
export const currentSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UserRow | null> => (await getCurrentUser()) ?? null,
)

export const login = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const record = input as { handle?: unknown; password?: unknown }
    if (
      typeof record.handle !== 'string' ||
      typeof record.password !== 'string'
    )
      throw new Error('handle and password are required')
    return { handle: record.handle, password: record.password }
  })
  .handler(async ({ data }) => {
    const user = await verifyLogin(systemDb, data.handle, data.password)
    if (!user) throw new Error('Wrong handle or password')
    const { token } = await createSession(systemDb, user.id)
    setSessionCookie(token)
    return user
  })

export const signup = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const record = input as {
      handle?: unknown
      password?: unknown
      inviteCode?: unknown
    }
    if (
      typeof record.handle !== 'string' ||
      typeof record.password !== 'string' ||
      typeof record.inviteCode !== 'string'
    )
      throw new Error('handle, password, and inviteCode are required')
    return {
      handle: record.handle,
      password: record.password,
      inviteCode: record.inviteCode,
    }
  })
  .handler(async ({ data }) => {
    const user = await signupUser(
      systemDb,
      data,
      process.env.SKYLARK_INVITE_CODE,
    )
    const { token } = await createSession(systemDb, user.id)
    setSessionCookie(token)
    return user
  })

export const logout = createServerFn({ method: 'POST' }).handler(async () => {
  const token = getCookie(SESSION_COOKIE)
  if (token) await deleteSession(systemDb, token)
  deleteCookie(SESSION_COOKIE, { path: '/' })
})
