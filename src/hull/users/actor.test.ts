import { afterEach, describe, expect, it } from 'vitest'

import { operatorHandle } from './actor'

describe('operatorHandle', () => {
  const original = process.env.SKYLARK_OPERATOR
  afterEach(() => {
    if (original === undefined) delete process.env.SKYLARK_OPERATOR
    else process.env.SKYLARK_OPERATOR = original
  })

  it('defaults to drufball when unset', () => {
    delete process.env.SKYLARK_OPERATOR
    expect(operatorHandle()).toBe('drufball')
  })

  it('honors the SKYLARK_OPERATOR override', () => {
    process.env.SKYLARK_OPERATOR = 'bix'
    expect(operatorHandle()).toBe('bix')
  })
})
