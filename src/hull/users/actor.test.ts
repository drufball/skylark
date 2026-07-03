import { afterEach, describe, expect, it } from 'vitest'

import { operatorHandle, operatorSeed } from './actor'

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
