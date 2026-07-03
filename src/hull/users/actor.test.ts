import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { cliActorOn, operatorHandle, operatorSeed, requireActor } from './actor'
import { getUserByHandle, seedCrew } from './service'
import type { UserRow } from './schema'

describe('operatorHandle', () => {
  const original = process.env.SKYLARK_OPERATOR
  afterEach(() => {
    if (original === undefined) delete process.env.SKYLARK_OPERATOR
    else process.env.SKYLARK_OPERATOR = original
  })

  it('defaults to the neutral captain when unset', () => {
    delete process.env.SKYLARK_OPERATOR
    expect(operatorHandle()).toBe('captain')
  })

  it('honors the SKYLARK_OPERATOR override', () => {
    process.env.SKYLARK_OPERATOR = 'bix'
    expect(operatorHandle()).toBe('bix')
  })

  it('operatorSeed derives the display name from the handle', () => {
    process.env.SKYLARK_OPERATOR = 'drufball'
    expect(operatorSeed()).toEqual({
      handle: 'drufball',
      displayName: 'Drufball',
    })
    delete process.env.SKYLARK_OPERATOR
    expect(operatorSeed()).toEqual({
      handle: 'captain',
      displayName: 'Captain',
    })
  })
})

describe('cliActorOn', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await seedCrew(db)
  })
  afterEach(() => close())

  it('an explicit SKYLARK_ACTOR id wins over the operator handle', async () => {
    const builder = defined(await getUserByHandle(db, 'builder'))
    const me = await cliActorOn(db, { SKYLARK_ACTOR: builder.id })
    expect(me?.id).toBe(builder.id)
    expect(me?.handle).toBe('builder')
  })

  it('an unknown explicit id resolves to undefined, never a fallback', async () => {
    // Fail closed: a mistyped agent identity must not quietly become the
    // operator — the caller decides whether missing is fatal.
    const me = await cliActorOn(db, {
      SKYLARK_ACTOR: '00000000-0000-7000-8000-000000000000',
    })
    expect(me).toBeUndefined()
  })

  it('falls back to the operator-handle lookup when SKYLARK_ACTOR is unset', async () => {
    const me = await cliActorOn(db, {})
    expect(me?.handle).toBe('captain')
  })

  it('the operator fallback honors SKYLARK_OPERATOR', async () => {
    const bix = defined(await getUserByHandle(db, 'bix'))
    const me = await cliActorOn(db, { SKYLARK_OPERATOR: 'bix' })
    expect(me?.id).toBe(bix.id)
  })
})

describe('requireActor', () => {
  it('passes a resolved actor through', () => {
    const row = { id: 'u1', handle: 'captain' } as UserRow
    expect(requireActor(row)).toBe(row)
  })

  it('fails closed with the seeding hint when nothing resolves', () => {
    expect(() => requireActor(undefined)).toThrow(
      /No actor resolved.*seed the crew.*SKYLARK_ACTOR/,
    )
  })
})
