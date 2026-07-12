import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentWaker,
  wakeBriefing,
  type AgentWakerDeps,
  type WakeableNotification,
} from './waker'

// The waker's decisions, driven with fake timers and fake deps — no runtime,
// no database, no real ten-second debounce. The fake inbox models the real
// service: markRead really consumes, so retry semantics are the genuine ones.

let seq = 0
function notification(
  over: Partial<WakeableNotification> = {},
): WakeableNotification {
  return {
    id: `n${String(++seq)}`,
    userId: 'agent-1',
    topic: 'issue:aa11',
    type: 'issue.status_changed',
    payload: { from: 'building', to: 'done' },
    actorId: 'builder-1',
    ...over,
  }
}

describe('wakeBriefing', () => {
  it('counts the batch and lists each line', () => {
    const briefing = wakeBriefing(['@builder moved it: building → done'])
    expect(briefing).toContain('1 update on work')
    expect(briefing).toContain('- @builder moved it: building → done')
    expect(wakeBriefing(['a', 'b'])).toContain('2 updates')
  })

  it('tells the agent to route the update itself via the chat CLI', () => {
    const briefing = wakeBriefing(['something moved'])
    expect(briefing).toContain('only job is triage')
    expect(briefing).toContain('chat CLI')
    expect(briefing).toContain('If no chat fits')
  })

  it('bounds the wake to routing — no doing the work itself', () => {
    const briefing = wakeBriefing(['something moved'])
    // The router routes; the crew in the routed-to chat owns any follow-up.
    expect(briefing).toContain('Do NOT investigate')
    expect(briefing).toMatch(/another session\s+owns the work/)
    expect(briefing).toMatch(/end your\s+turn/)
    // The old do-work instructions must be gone — they sent inbox sessions
    // rogue (debugging CI, filing issues, polling checks in a loop).
    expect(briefing).not.toContain('Review what happened')
    expect(briefing).not.toContain('file follow-up issues')
    expect(briefing).not.toContain('kick off')
    expect(briefing).not.toContain('check the result')
  })
})

describe('createAgentWaker', () => {
  let deps: AgentWakerDeps & {
    wakes: { agentUserId: string; briefing: string }[]
    unread: WakeableNotification[]
  }

  beforeEach(() => {
    vi.useFakeTimers()
    const wakes: (typeof deps)['wakes'] = []
    deps = {
      wakes,
      unread: [],
      isAgent: (userId) => Promise.resolve(userId.startsWith('agent')),
      listUnread: () => Promise.resolve([...deps.unread]),
      // A REAL consume: marked entries leave the unread list, like the service.
      markRead: (_userId, ids) => {
        deps.unread = deps.unread.filter((n) => !ids.includes(n.id))
        return Promise.resolve()
      },
      describe: (n) => Promise.resolve(`describe(${n.type})`),
      wake: (agentUserId, briefing) => {
        wakes.push({ agentUserId, briefing })
        return Promise.resolve()
      },
      debounceMs: 10_000,
    }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gathers a flurry into ONE wake after the debounce, consuming the batch', async () => {
    const waker = createAgentWaker(deps)
    deps.unread = [
      notification({ type: 'issue.status_changed' }),
      notification({ type: 'issue.commented' }),
    ]
    waker.onNotified(deps.unread[0])
    waker.onNotified(deps.unread[1]) // lands inside the window — no second timer

    await vi.advanceTimersByTimeAsync(9_999)
    expect(deps.wakes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => {
      expect(deps.wakes).toHaveLength(1)
    })

    const [wake] = deps.wakes
    expect(wake.agentUserId).toBe('agent-1')
    expect(wake.briefing).toContain('2 updates')
    expect(wake.briefing).toContain('describe(issue.status_changed)')
    expect(wake.briefing).toContain('describe(issue.commented)')
    // Delivered = consumed.
    expect(deps.unread).toHaveLength(0)
  })

  it('arms exactly one timer per agent — a flurry never schedules a second fire', async () => {
    // markRead deliberately does NOT consume here: if the debounce armed a
    // second timer, its fire would still see unread rows and wake AGAIN. With
    // a single armed timer there is exactly one wake no matter what.
    deps.markRead = () => Promise.resolve()
    const waker = createAgentWaker(deps)
    deps.unread = [
      notification({ type: 'issue.status_changed' }),
      notification({ type: 'issue.commented' }),
    ]
    waker.onNotified(deps.unread[0])
    waker.onNotified(deps.unread[1])

    await vi.advanceTimersByTimeAsync(20_000) // both windows, if two were armed
    await vi.waitFor(() => {
      expect(deps.wakes.length).toBeGreaterThan(0)
    })
    expect(deps.wakes).toHaveLength(1)
  })

  it('never wakes a human — their inbox stays unread for the bell', async () => {
    const waker = createAgentWaker(deps)
    deps.unread = [notification({ userId: 'human-1' })]
    waker.onNotified(deps.unread[0])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.wakes).toHaveLength(0)
    expect(deps.unread).toHaveLength(1)
  })

  it('one wake per agent even when the batch spans several issues', async () => {
    const waker = createAgentWaker(deps)
    deps.unread = [
      notification({ topic: 'issue:aa11' }),
      notification({ topic: 'issue:bb22', type: 'issue.commented' }),
      notification({ topic: 'issue:cc33', type: 'issue.opened' }),
    ]
    waker.onNotified(deps.unread[0])
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => {
      expect(deps.wakes).toHaveLength(1)
    })
    // The whole backlog rides one briefing — routing is the agent's judgment,
    // not the waker's — and delivery consumes everything.
    expect(deps.wakes[0].briefing).toContain('3 updates')
    expect(deps.wakes[0].briefing).toContain('describe(issue.opened)')
    expect(deps.unread).toHaveLength(0)
  })

  it('does nothing when the inbox drained before the debounce fired', async () => {
    const waker = createAgentWaker(deps)
    deps.unread = []
    waker.onNotified(notification())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.wakes).toHaveLength(0)
  })

  it('a failed wake leaves its batch UNREAD, and the next notification retries it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      deps.wake = () => Promise.reject(new Error('session exploded'))
      const waker = createAgentWaker(deps)
      const first = notification()
      deps.unread = [first]
      waker.onNotified(first)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled()
      })
      // NOT consumed — delivery failed, the briefing is still owed.
      expect(deps.unread).toHaveLength(1)

      // A later notification re-arms; the retried wake carries the backlog.
      deps.wake = (agentUserId, briefing) => {
        deps.wakes.push({ agentUserId, briefing })
        return Promise.resolve()
      }
      const second = notification()
      deps.unread.push(second)
      waker.onNotified(second)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(deps.wakes).toHaveLength(1)
      })
      expect(deps.wakes[0].briefing).toContain('2 updates')
      expect(deps.unread).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('never overlaps wakes: a notification during a slow delivery waits, then gets its own wake', async () => {
    // The #75fq race: fire() clears the timer at its start, so under the old
    // code a notification landing DURING a slow deps.wake armed a second
    // timer and a second wake overlapped the first. Now it must wait for
    // delivery to finish — and then still be delivered, never dropped.
    const first = notification()
    deps.unread = [first]
    // A slow wake: resolves 5s after being called (fake-timer time).
    deps.wake = (agentUserId, briefing) => {
      deps.wakes.push({ agentUserId, briefing })
      return new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    const waker = createAgentWaker(deps)
    waker.onNotified(first)

    // Enter fire: the timer fires at 10s, the wake is now in flight.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.wakes).toHaveLength(1)

    // A second notification lands mid-delivery. Old code: second timer.
    const second = notification({ type: 'issue.commented' })
    deps.unread.push(second)
    waker.onNotified(second)

    // Let the first delivery finish. Nothing may overlap it.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.wakes).toHaveLength(1)

    // Delivery finishing re-armed one fresh window for the mid-flight
    // arrival: one more debounce later it gets its own wake.
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => {
      expect(deps.wakes).toHaveLength(2)
    })
    expect(deps.wakes[1].briefing).toContain('describe(issue.commented)')
    // …and once ITS slow delivery finishes, the batch is consumed.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.unread).toHaveLength(0)
  })

  it('a failed wake cannot wedge the agent: the in-flight guard always clears', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      deps.wake = () => Promise.reject(new Error('session exploded'))
      const waker = createAgentWaker(deps)
      const first = notification()
      deps.unread = [first]
      waker.onNotified(first)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled()
      })

      // The guard must not outlive the failed fire: a later notification
      // arms a fresh timer and delivers the backlog.
      deps.wake = (agentUserId, briefing) => {
        deps.wakes.push({ agentUserId, briefing })
        return Promise.resolve()
      }
      const second = notification()
      deps.unread.push(second)
      waker.onNotified(second)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(deps.wakes).toHaveLength(1)
      })
      expect(deps.wakes[0].briefing).toContain('2 updates')
    } finally {
      spy.mockRestore()
    }
  })
})
