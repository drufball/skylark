import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentWaker } from './waker'

describe('createAgentWaker', () => {
  let deps: any
  let waker: ReturnType<typeof createAgentWaker>

  beforeEach(() => {
    deps = {
      isAgent: vi.fn(),
      listUnread: vi.fn(),
      markRead: vi.fn(),
      chatForTopic: vi.fn(),
      describe: vi.fn(),
      wake: vi.fn(),
      debounceMs: 100,
    }
    waker = createAgentWaker(deps)
  })

  it('should prevent overlapping wakes when notifications arrive during fire execution', async () => {
    // Set up the scenario where fire takes time to complete 
    deps.isAgent.mockResolvedValue(true)
    deps.listUnread.mockResolvedValue([
      { id: '1', userId: 'user1', topic: 'topic1', type: 'type1', payload: {}, actorId: null },
    ])
    
    // Mock a long-running wake
    deps.describe.mockResolvedValue('test description')
    deps.chatForTopic.mockResolvedValue('chat1')
    deps.wake.mockImplementation(() => {
      return new Promise(resolve => setTimeout(resolve, 200))
    })

    // Send first notification - this will start a timer
    waker.onNotified({ id: '1', userId: 'user1', topic: 'topic1', type: 'type1', payload: {}, actorId: null })
    
    // Wait a bit to let the timer fire (but don't wait for it to finish yet)
    await new Promise(resolve => setTimeout(resolve, 50))
    
    // Send second notification during processing - this should NOT create another timer
    waker.onNotified({ id: '2', userId: 'user1', topic: 'topic2', type: 'type2', payload: {}, actorId: null })
    
    // Wait for the first fire to complete  
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // If fix works correctly, wake should be called exactly once
    expect(deps.wake).toHaveBeenCalledTimes(1)
  })

  it('should process multiple sequential notifications properly', async () => {
    deps.isAgent.mockResolvedValue(true)
    deps.listUnread.mockResolvedValue([
      { id: '1', userId: 'user1', topic: 'topic1', type: 'type1', payload: {}, actorId: null },
    ])
    deps.describe.mockResolvedValue('test description')
    deps.chatForTopic.mockResolvedValue('chat1')
    deps.wake.mockResolvedValue(undefined)
    
    // Send first notification
    waker.onNotified({ id: '1', userId: 'user1', topic: 'topic1', type: 'type1', payload: {}, actorId: null })  
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Send second notification after first completes - should work normally
    waker.onNotified({ id: '2', userId: 'user1', topic: 'topic2', type: 'type2', payload: {}, actorId: null })
    await new Promise(resolve => setTimeout(resolve, 200))
    
    expect(deps.wake).toHaveBeenCalledTimes(2)
  })
})