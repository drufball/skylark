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
    expect(briefing).toContain('Review what happened')
    expect(wakeBriefing(['a', 'b'])).toContain('2 updates')
  })
})

describe('createAgentWaker', () => {
  let deps: AgentWakerDeps & {
    wakes: { chatId: string; agentUserId: string; briefing: string }[]
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
      chatForTopic: (topic) =>
        Promise.resolve(topic === 'issue:aa11' ? 'chat-1' : null),
      describe: (n) => Promise.resolve(`describe(${n.type})`),
      wake: (chatId, agentUserId, briefing) => {
        wakes.push({ chatId, agentUserId, briefing })
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
    expect(wake).toMatchObject({ chatId: 'chat-1', agentUserId: 'agent-1' })
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

  it('wakes per chat when the batch spans several origins; orphans are consumed without one', async () => {
    deps.chatForTopic = (topic) =>
      Promise.resolve(
        topic === 'issue:aa11'
          ? 'chat-1'
          : topic === 'issue:bb22'
            ? 'chat-2'
            : null,
      )
    const waker = createAgentWaker(deps)
    deps.unread = [
      notification({ topic: 'issue:aa11' }),
      notification({ topic: 'issue:bb22' }),
      notification({ topic: 'issue:orphan' }), // no origin chat — no wake
    ]
    waker.onNotified(deps.unread[0])
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => {
      expect(deps.wakes).toHaveLength(2)
    })
    expect(deps.wakes.map((w) => w.chatId).sort()).toEqual(['chat-1', 'chat-2'])
    // Everything consumed: two by delivery, the orphan because an agent inbox
    // has no other reader.
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
      deps.wake = (chatId, agentUserId, briefing) => {
        deps.wakes.push({ chatId, agentUserId, briefing })
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
})
