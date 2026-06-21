import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DATABASE_URL,
  resolveDatabaseUrl,
  SMOKE_DB_NAME,
  withDbName,
} from './url'

describe('withDbName', () => {
  it('swaps only the database name, keeping host/port/credentials', () => {
    expect(
      withDbName('postgres://u:p@db.example.com:6543/skylark', 'skylark_smoke'),
    ).toBe('postgres://u:p@db.example.com:6543/skylark_smoke')
  })
})

describe('resolveDatabaseUrl', () => {
  it('uses DATABASE_URL when set, else the local default', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://x/db' })).toBe(
      'postgres://x/db',
    )
    expect(resolveDatabaseUrl({})).toBe(DEFAULT_DATABASE_URL)
  })

  it('forces the smoke database in fake-runtime mode, ignoring DATABASE_URL', () => {
    // The safety guarantee: a smoke run can never touch the real db, even when
    // DATABASE_URL names it — only the db NAME is forced, the server is kept.
    const real = 'postgres://u:p@localhost:5432/skylark'
    const smoke = resolveDatabaseUrl({
      DATABASE_URL: real,
      SKYLARK_FAKE_RUNTIME: '1',
    })
    expect(smoke).toBe(`postgres://u:p@localhost:5432/${SMOKE_DB_NAME}`)
    expect(smoke).not.toContain('/skylark?')
    expect(new URL(smoke).pathname).toBe(`/${SMOKE_DB_NAME}`)
  })

  it('derives the smoke db on the default server when no DATABASE_URL is set', () => {
    expect(resolveDatabaseUrl({ SKYLARK_FAKE_RUNTIME: '1' })).toBe(
      withDbName(DEFAULT_DATABASE_URL, SMOKE_DB_NAME),
    )
  })
})
