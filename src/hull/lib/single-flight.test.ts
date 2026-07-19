import { describe, expect, it } from 'vitest'

import { singleFlight } from './single-flight'

/** A promise plus its resolve/reject handles, for driving timing by hand. */
function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (e: unknown) => void
} {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('singleFlight', () => {
  it('drops calls made while one is in flight', async () => {
    let calls = 0
    const d = deferred()
    const wrapped = singleFlight(() => {
      calls += 1
      return d.promise
    })

    void wrapped() // starts the one run
    await wrapped() // dropped — resolves immediately without invoking fn again
    expect(calls).toBe(1)

    d.resolve()
  })

  it('runs again once the prior call settles', async () => {
    let calls = 0
    const wrapped = singleFlight(() => {
      calls += 1
      return Promise.resolve()
    })

    await wrapped()
    await wrapped()
    expect(calls).toBe(2)
  })

  it('does not wedge the gate shut when a run rejects', async () => {
    let calls = 0
    const wrapped = singleFlight(() => {
      calls += 1
      return Promise.reject(new Error('boom'))
    })

    await expect(wrapped()).rejects.toThrow('boom')
    // The gate reset in finally, so the next call still runs.
    await expect(wrapped()).rejects.toThrow('boom')
    expect(calls).toBe(2)
  })
})
