import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'

import { getShipDefaultModel, setShipDefaultModel } from './settings'

describe('ship settings: the default-model override', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('is unset on a fresh ship', async () => {
    expect(await getShipDefaultModel(db)).toBeNull()
  })

  it('is set and read back', async () => {
    await setShipDefaultModel(db, 'claude-opus-4-5')
    expect(await getShipDefaultModel(db)).toBe('claude-opus-4-5')
  })

  it('is idempotent — setting it again converges the one row, never a second', async () => {
    await setShipDefaultModel(db, 'claude-opus-4-5')
    await setShipDefaultModel(db, 'claude-haiku-4-5')
    expect(await getShipDefaultModel(db)).toBe('claude-haiku-4-5')
  })

  it('clears back to null (defer to SKYLARK_DEFAULT_MODEL) when set to null', async () => {
    await setShipDefaultModel(db, 'claude-opus-4-5')
    await setShipDefaultModel(db, null)
    expect(await getShipDefaultModel(db)).toBeNull()
  })

  it('rejects a blank override rather than storing empty-string noise', async () => {
    await expect(setShipDefaultModel(db, '')).rejects.toThrow(/empty/i)
    await expect(setShipDefaultModel(db, '   ')).rejects.toThrow(/empty/i)
  })
})
