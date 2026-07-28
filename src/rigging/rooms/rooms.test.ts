import { describe, expect, it } from 'vitest'

import { SEED_AGENTS } from '@hull/users/service'
import { resolveWidget } from '@rigging/widgets/registry'

import { DEFAULT_ROOMS } from './rooms'

// The default rooms are DATA — a title, an agent, and widget blobs. Nothing
// checks them at runtime (the seed just writes rows), so this file is the
// check: every room names a kind this ship can render, with props the catalog
// actually accepts, and an agent the crew seed actually puts aboard.

describe('the default rooms', () => {
  it('gives every room a distinct well-known id', () => {
    const ids = DEFAULT_ROOMS.map((room) => room.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('opens a room for each of the ship’s three standing surfaces', () => {
    expect(DEFAULT_ROOMS.map((room) => room.title)).toEqual([
      'Issues',
      'Files',
      'Inbox',
    ])
  })

  it('arranges only widgets the catalog can render, with props it accepts', () => {
    for (const room of DEFAULT_ROOMS) {
      expect(room.widgets.length).toBeGreaterThan(0)
      for (const widget of room.widgets) {
        const resolved = resolveWidget(widget.kind, widget.props)
        expect(
          resolved.ok,
          `${room.title}/${widget.kind}: ${resolved.ok ? '' : resolved.detail}`,
        ).toBe(true)
      }
    }
  })

  it('puts an agent from the standard crew in every room', () => {
    // "The agent is right there beside the thing" is the whole point of a room,
    // so a room with nobody in it would be a dead surface — and the handle has
    // to be one the crew seed really creates, not a new persona invented here.
    const aboard = new Set(SEED_AGENTS.map((agent) => agent.handle))
    for (const room of DEFAULT_ROOMS) {
      expect(aboard.has(room.agentHandle), room.agentHandle).toBe(true)
    }
  })
})
