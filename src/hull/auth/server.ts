import { createServerFn } from '@tanstack/react-start'
import {
  deleteCookie,
  getCookie,
  getRequestHost,
  getRequestProtocol,
  getRequestUrl,
  setCookie,
} from '@tanstack/react-start/server'

import { systemDb } from '@hull/db/client'
import { getCurrentUser } from '@hull/users/actor'
import type { UserRow } from '@hull/users/schema'

import { canonicalOriginRedirect } from './origin'
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
 * misconfigure. Verified empirically against a real `cloudflared` tunnel
 * (#q6xm): it always sets `x-forwarded-proto: https` on the request it
 * forwards to the origin, so this is reliable for every request that
 * actually crossed the tunnel. The remaining risk isn't this header — it's a
 * browser reaching the app on a SECOND origin entirely (a LAN address, no
 * TLS), which `canonicalRedirectUrl` below closes off before login ever runs. */
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

/**
 * If this request didn't arrive on the ship's one public hostname (and isn't
 * plain local dev), the absolute URL to redirect to instead — otherwise null.
 * The root route's `beforeLoad` throws this before `currentSession` even
 * runs, so a browser on a LAN address is sent to the canonical origin BEFORE
 * it could set (or read) a cookie scoped to the wrong one — one origin, one
 * cookie jar, no "logged in on wifi but not on cellular" (#q6xm).
 */
export const canonicalRedirectUrl = createServerFn({ method: 'GET' }).handler(
  (): string | null =>
    canonicalOriginRedirect({
      host: getRequestHost(),
      publicHost: process.env.SKYLARK_PUBLIC_HOST,
      path: getRequestUrl().pathname + getRequestUrl().search,
    }),
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
