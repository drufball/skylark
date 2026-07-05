import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'
import { getUserByHandle, seedCrew } from '@hull/users/service'

import {
  createSession,
  deleteSession,
  getSessionUser,
  hashPassword,
  hashToken,
  MIN_PASSWORD_LENGTH,
  setPassword,
  signup,
  verifyLogin,
  verifyPassword,
} from './service'
import { sessions } from './schema'

describe('password hashing', () => {
  it('verifies a matching password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(
      true,
    )
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false)
  })

  it('salts each hash differently, even for the same password', async () => {
    const a = await hashPassword('same password')
    const b = await hashPassword('same password')
    expect(a).not.toBe(b)
  })

  it('rejects garbage stored hashes rather than throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false)
  })
})

describe('sessions', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await seedCrew(db)
  })
  afterEach(() => close())

  it('a fresh session resolves back to its user', async () => {
    const captain = defined(await getUserByHandle(db, 'captain'))
    const { token } = await createSession(db, captain.id)
    const me = await getSessionUser(db, token)
    expect(me?.id).toBe(captain.id)
  })

  it('an unknown token resolves to undefined', async () => {
    const me = await getSessionUser(db, 'not-a-real-token')
    expect(me).toBeUndefined()
  })

  it('never stores the raw token — only its hash is in the row', async () => {
    const captain = defined(await getUserByHandle(db, 'captain'))
    const { token } = await createSession(db, captain.id)
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, captain.id))
    expect(defined(row).tokenHash).toBe(hashToken(token))
    expect(defined(row).tokenHash).not.toBe(token)
  })

  it('an expired session no longer resolves', async () => {
    const captain = defined(await getUserByHandle(db, 'captain'))
    const { token } = await createSession(db, captain.id)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 1000 * 60 * 60 * 24 * 365)
    expect(await getSessionUser(db, token)).toBeUndefined()
    vi.useRealTimers()
  })

  it('logout deletes the session — it no longer resolves', async () => {
    const captain = defined(await getUserByHandle(db, 'captain'))
    const { token } = await createSession(db, captain.id)
    await deleteSession(db, token)
    expect(await getSessionUser(db, token)).toBeUndefined()
  })
})

describe('verifyLogin', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await seedCrew(db)
  })
  afterEach(() => close())

  it('succeeds with the right handle + password', async () => {
    const captain = defined(await getUserByHandle(db, 'captain'))
    await signup(
      db,
      { handle: 'captain', password: 'hunter22222', inviteCode: 'letmein' },
      'letmein',
    )
    const me = await verifyLogin(db, 'captain', 'hunter22222')
    expect(me?.id).toBe(captain.id)
  })

  it('fails with the wrong password', async () => {
    await signup(
      db,
      { handle: 'captain', password: 'hunter22222', inviteCode: 'letmein' },
      'letmein',
    )
    expect(await verifyLogin(db, 'captain', 'wrong password')).toBeUndefined()
  })

  it('fails for a handle with no credentials at all', async () => {
    expect(await verifyLogin(db, 'captain', 'anything')).toBeUndefined()
  })

  it('fails for an unknown handle', async () => {
    expect(await verifyLogin(db, 'nobody', 'anything')).toBeUndefined()
  })
})

describe('signup', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('rejects a missing invite code (fail closed when unconfigured)', async () => {
    await expect(
      signup(
        db,
        { handle: 'dru', password: 'hunter22222', inviteCode: 'letmein' },
        undefined,
      ),
    ).rejects.toThrow(/invite/i)
  })

  it('rejects the wrong invite code', async () => {
    await expect(
      signup(
        db,
        { handle: 'dru', password: 'hunter22222', inviteCode: 'wrong' },
        'letmein',
      ),
    ).rejects.toThrow(/invite/i)
  })

  it('creates a brand-new human user + credentials on a fresh handle', async () => {
    const user = await signup(
      db,
      { handle: 'dru', password: 'hunter22222', inviteCode: 'letmein' },
      'letmein',
    )
    expect(user.handle).toBe('dru')
    expect(user.type).toBe('human')
    const me = await verifyLogin(db, 'dru', 'hunter22222')
    expect(me?.id).toBe(user.id)
  })

  it('rejects a password shorter than the minimum', async () => {
    await expect(
      signup(
        db,
        { handle: 'dru', password: 'short', inviteCode: 'letmein' },
        'letmein',
      ),
    ).rejects.toThrow(new RegExp(String(MIN_PASSWORD_LENGTH)))
  })

  it('rejects an invalid handle', async () => {
    await expect(
      signup(
        db,
        { handle: 'Not Valid', password: 'hunter22222', inviteCode: 'letmein' },
        'letmein',
      ),
    ).rejects.toThrow(/invalid/i)
  })

  it('claims an existing passwordless human row (e.g. the seeded operator)', async () => {
    await seedCrew(db)
    const existing = defined(await getUserByHandle(db, 'captain'))
    const claimed = await signup(
      db,
      {
        handle: 'captain',
        password: 'hunter22222',
        inviteCode: 'letmein',
      },
      'letmein',
    )
    expect(claimed.id).toBe(existing.id)
    const me = await verifyLogin(db, 'captain', 'hunter22222')
    expect(me?.id).toBe(existing.id)
  })

  it('rejects a handle that already has credentials', async () => {
    await signup(
      db,
      { handle: 'dru', password: 'hunter22222', inviteCode: 'letmein' },
      'letmein',
    )
    await expect(
      signup(
        db,
        {
          handle: 'dru',
          password: 'different password',
          inviteCode: 'letmein',
        },
        'letmein',
      ),
    ).rejects.toThrow(/taken/i)
  })

  it('rejects signing up as an existing agent handle', async () => {
    await seedCrew(db)
    await expect(
      signup(
        db,
        { handle: 'tilde', password: 'hunter22222', inviteCode: 'letmein' },
        'letmein',
      ),
    ).rejects.toThrow(/agent/i)
  })
})

describe('setPassword', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await seedCrew(db)
  })
  afterEach(() => close())

  it('sets a password for a user with none yet — the CLI recovery path', async () => {
    const captain = defined(await getUserByHandle(db, 'captain'))
    await setPassword(db, captain.id, 'brand new password')
    const me = await verifyLogin(db, 'captain', 'brand new password')
    expect(me?.id).toBe(captain.id)
  })

  it('overwrites an existing password', async () => {
    const captain = defined(await getUserByHandle(db, 'captain'))
    await setPassword(db, captain.id, 'first password')
    await setPassword(db, captain.id, 'second password')
    expect(await verifyLogin(db, 'captain', 'first password')).toBeUndefined()
    expect((await verifyLogin(db, 'captain', 'second password'))?.id).toBe(
      captain.id,
    )
  })
})
